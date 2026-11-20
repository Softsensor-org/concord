"use strict";

// COORD-915 / ADR 0021 Decision item 6: canonical integration is a separate
// permission. These tests drive the real CLI in disposable governed fixtures
// with two runtime threads (two sessions) sharing one coordination domain, the
// shape of the 2026-11-06 incident in which a second registered session ran
// `gov sync --commit` between another orchestrator's PR merge and its finalize.

const test = require("node:test");
const { gitFixtureEnv, gitFixtureSpawn } = require("./test-git-fixture.js"); // COORD-952
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT = path.resolve(__dirname, "..", "..");
const { installCanonicalEngine } = require(resolveEngineModule(COORD_ROOT, "scripts/fixtures/coord-engine-schemas.js"));
const { withApprovedPacket } = require(resolveEngineModule(COORD_ROOT, "scripts/fixtures/approved-reconcile.js"));
const { withScopedGovernanceTestContext } = require(resolveEngineModule(COORD_ROOT, "scripts/governance-test-utils.js"));
const authority = require("./integration-authority.js");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");
const attemptCoordination = require("./attempt-coordination.js");
const { parseArgs } = require("./integration-commands.js");
const { createIntegrationCommands } = require("./integration-commands.js");
const createTicketTransitions = require("./ticket-transitions.js");
const { crashAtHold, isAlive, waitUntil } = require("./__fixtures__/process-group-kill.js"); // COORD-1005
const HOLD_HELPER = path.join(__dirname, "__fixtures__", "process-group-kill.js");

test("COORD-1047: ticket-fence dependency resolution reuses canonical providers and preserves explicit invalid overrides", () => {
  const resolved = authority.resolveTicketFenceDependencies({}, { includeDecision: true });
  assert.equal(resolved.assertTicketFence, authority.assertTicketFence);
  assert.equal(resolved.decisionFenceForTicket, authority.decisionFenceForTicket);
  const invalid = authority.resolveTicketFenceDependencies({ assertTicketFence: null }, { includeDecision: true });
  assert.equal(invalid.assertTicketFence, null, "an explicit invalid override is not replaced with a default");
  assert.equal(invalid.decisionFenceForTicket, authority.decisionFenceForTicket);
});

test("COORD-1047: a pre-fence operation refuses against an existing canonical decision before effects", () => {
  withCanonicalAuthorityContext(({ root, git, setThread }) => {
    const remote = path.join(root, "attempt-origin.git");
    const bare = gitFixtureSpawn(root, ["init", "--bare", "--initial-branch=main", remote]);
    assert.equal(bare.status, 0, bare.stderr);
    git("remote", "add", "origin", remote);
    const ticket = "TEST-915";
    setThread("thread-old");
    const caller = authority.resolveCaller();
    authority.writeRecord({ ...authority.emptyRecord(), holder: authority.grantHolder(caller, "test", "legacy-operation"), authority_epoch: 7 },
      { event: "attempt-fence-legacy-operation-holder" });
    const operation = authority.newOperation("finalize", ticket, caller, "terminal-verb");
    delete operation.baseline.attempt_fence; // simulate an operation persisted before COORD-1047
    authority.writeRecord({ ...authority.readRecord(), operation }, { event: "attempt-fence-legacy-operation-opened" });

    const legacyRecord = authority.readRecord();
    assert.deepEqual(authority.decisionFenceForTicket(ticket), {
      status: "legacy-absent", remote: "origin", ticket, reason: "operation-predates-capture",
    });
    assert.deepEqual(authority.assertTicketFence(ticket), { ok: true, legacy: true });
    assert.deepEqual(authority.readRecord(), legacyRecord, "legacy verification preserves the operation");

    attemptCoordination.bootstrapCanonical(root, { remote: "origin", ticket, owner: ORCH, authorityEpoch: 7 });
    const externalEffects = [];
    assert.throws(() => {
      authority.assertTicketFence(ticket);
      externalEffects.push("publish");
    }, /persisted integration operation has no captured attempt fence; abandon and reopen it/);
    assert.deepEqual(externalEffects, [], "an old operation cannot reach a publication or closeout effect without its original decision token");
  });
});

test("COORD-1047: terminal decision fence persists and refuses stale, missing, and epoch-mismatched canonical state", () => {
  withCanonicalAuthorityContext(({ root, git, setThread }) => {
    const remote = path.join(root, "attempt-origin.git");
    const bare = gitFixtureSpawn(root, ["init", "--bare", "--initial-branch=main", remote]);
    assert.equal(bare.status, 0, bare.stderr);
    git("remote", "add", "origin", remote);
    setThread("thread-old");
    const caller = authority.resolveCaller();
    const ticket = "TEST-915";
    const captured = attemptCoordination.bootstrapCanonical(root, { remote: "origin", ticket, owner: ORCH, authorityEpoch: 7 });
    const openOperation = () => {
      authority.writeRecord({ ...authority.emptyRecord(), holder: authority.grantHolder(caller, "test", "fence-test"), authority_epoch: 7 },
        { event: "attempt-fence-test-holder" });
      const operation = authority.newOperation("finalize", ticket, caller, "terminal-verb");
      assert.equal(operation.baseline.attempt_fence.status, "captured");
      authority.writeRecord({ ...authority.readRecord(), operation },
        { event: "attempt-fence-test-opened" });
      return operation;
    };
    const effects = [];
    const fencedEffect = () => { authority.assertTicketFence(ticket); effects.push("effect"); };

    const first = openOperation();
    assert.match(first.baseline.attempt_fence.token, /^TEST-915@0:/);
    assert.equal(first.baseline.attempt_fence.authority_epoch, 7);
    assert.deepEqual(authority.decisionFenceForTicket(ticket), first.baseline.attempt_fence,
      "an operation retry reuses its originally captured token instead of recapturing the new remote state");
    assert.doesNotThrow(fencedEffect);
    const held = authority.readRecord();
    authority.writeRecord({ ...held, authority_epoch: 8 }, { event: "attempt-fence-test-local-handoff" });
    assert.throws(fencedEffect, /canonical authority epoch 7 differs from the holder's epoch 8/,
      "an unchanged canonical token is refused when the local authority epoch advances");
    assert.throws(() => authority.captureTicketFence(ticket), /canonical authority epoch 7 differs from the holder's epoch 8/,
      "a fresh terminal decision cannot capture canonical state from an older authority epoch");
    authority.writeRecord({ ...authority.readRecord(), authority_epoch: 7 }, { event: "attempt-fence-test-local-restored" });
    let canonical = attemptCoordination.readCanonical(root, { remote: "origin", ticket });
    const advanced = { ...canonical.record, generation: canonical.record.generation + 1, updated_at: new Date().toISOString() };
    attemptCoordination.publishCanonicalTransition(root, { remote: "origin", ticket, expected: canonical, next: advanced });
    assert.throws(fencedEffect, /canonical attempt fence is stale/);
    assert.equal(effects.length, 1, "a stale decision does not reach the side effect");

    const canonicalRef = "refs/heads/coord-state/canonical/TEST-915";
    const removed = spawnSync("git", ["--git-dir", remote, "update-ref", "-d", canonicalRef], { encoding: "utf8" });
    assert.equal(removed.status, 0, removed.stderr);
    assert.throws(fencedEffect, /canonical attempt fence is absent/);
    assert.equal(effects.length, 1, "a disappeared decision does not reach the side effect");

    attemptCoordination.bootstrapCanonical(root, { remote: "origin", ticket, owner: ORCH, authorityEpoch: 7 });
    const epochOperation = openOperation();
    const record = authority.readRecord();
    const tamperedFence = { ...record.operation.baseline.attempt_fence, authority_epoch: 6 };
    authority.writeRecord({ ...record, operation: { ...record.operation, baseline: { ...record.operation.baseline, attempt_fence: tamperedFence } } },
      { event: "attempt-fence-test-stale-epoch" });
    assert.throws(fencedEffect, /canonical authority epoch 6 differs from the holder's epoch 7/);
    assert.equal(effects.length, 1, "an epoch mismatch does not reach the side effect");
    assert.equal(epochOperation.baseline.attempt_fence.selected_attempt, null);
    assert.ok(captured.oid);
  });
});

test("COORD-1047: only a verified off-Git workspace gets the legacy fence; other Git topology errors refuse", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1047-off-git-fence-"));
  try {
    const offGit = path.join(root, "off-git");
    fs.mkdirSync(offGit);
    const legacy = withScopedGovernanceTestContext({ RUNTIME_DIR: path.join(offGit, ".runtime") },
      () => authority.captureTicketFence("TEST-915"));
    assert.equal(legacy.reason, "legacy-off-git");
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = offGit;
      assert.throws(
        () => withScopedGovernanceTestContext({ RUNTIME_DIR: path.join(offGit, ".runtime") },
          () => authority.captureTicketFence("TEST-915")),
        /Could not inspect the Git topology.*git rev-parse failed/,
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    const missing = path.join(root, "missing", ".runtime");
    assert.throws(
      () => withScopedGovernanceTestContext({ RUNTIME_DIR: missing }, () => authority.captureTicketFence("TEST-915")),
      /Could not inspect the Git topology/,
    );
    withCanonicalAuthorityContext(({ root: repo, git }) => {
      const config = path.join(repo, ".git", "config");
      fs.appendFileSync(config, '\n[remote "origin"]\n\turl\n');
      assert.equal(fs.realpathSync(git("rev-parse", "--show-toplevel")), fs.realpathSync(repo));
      assert.throws(() => authority.assertTicketFence("TEST-915"),
        /Could not inspect configured attempt remotes.*missing value for 'remote.origin.url'/s);
      assert.equal(authority.readRecord(), null);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-1047: a planned provisional first grant matches its canonical authority epoch", () => {
  withCanonicalAuthorityContext(({ root, git, setThread }) => {
    const remote = path.join(root, "attempt-origin.git");
    const bare = gitFixtureSpawn(root, ["init", "--bare", "--initial-branch=main", remote]);
    assert.equal(bare.status, 0, bare.stderr);
    git("remote", "add", "origin", remote);
    const ticket = "TEST-916";
    attemptCoordination.bootstrapCanonical(root, { remote: "origin", ticket, owner: ORCH, authorityEpoch: 1 });
    setThread("thread-old");
    const caller = authority.resolveCaller();
    const operation = authority.newOperation("finalize", ticket, caller, "terminal-verb", 1);
    const holder = authority.grantHolder(caller, "test", "provisional-epoch");
    holder.provisional = { pid: process.pid, host: os.hostname() };
    authority.writeRecord({ ...authority.emptyRecord(), holder, operation }, { event: "attempt-fence-provisional-opened" });
    assert.equal(authority.readRecord().authority_epoch, 0, "the provisional grant has not yet committed its epoch");
    assert.doesNotThrow(() => authority.assertTicketFence(ticket), "the active provisional executor uses its planned epoch 1");
  });
});

// withCanonicalAuthorityContext creates and removes its workspace under os.tmpdir();
// the board-mutating-suite guard includes this file because this test reaches markDone.
test("COORD-1047: finalize rechecks a moved canonical decision after readiness and before the DONE write", () => {
  withCanonicalAuthorityContext(({ root, git, setThread }) => {
    const remote = path.join(root, "attempt-origin.git");
    const bare = gitFixtureSpawn(root, ["init", "--bare", "--initial-branch=main", remote]);
    assert.equal(bare.status, 0, bare.stderr);
    git("remote", "add", "origin", remote);
    const ticket = "TEST-915";
    const bootstrap = attemptCoordination.bootstrapCanonical(root, { remote: "origin", ticket, owner: ORCH, status: "review", authorityEpoch: 11 });
    setThread("thread-old");
    const caller = authority.resolveCaller();
    authority.writeRecord({ ...authority.emptyRecord(), holder: authority.grantHolder(caller, "test", "fence-test"), authority_epoch: 11 },
      { event: "attempt-fence-finalize-holder" });
    const operation = authority.newOperation("finalize", ticket, caller, "terminal-verb");
    authority.writeRecord({ ...authority.readRecord(), operation },
      { event: "attempt-fence-finalize-opened" });
    const row = { ID: ticket, Repo: "B", Status: "review", Owner: ORCH };
    const board = { sections: [{ rows: [row] }] };
    let writes = 0;
    const deps = Object.fromEntries(createTicketTransitions.DEP_CONTRACT.callable.map((name) => [name, () => {}]));
    Object.assign(deps, {
      fail: (message) => { throw new Error(message); },
      BOARD_RAW_SYMBOL: Symbol.for("test.plan.raw"),
      readBoard: () => board,
      getTicketRef: () => ({ row }),
      inferTicketStatus: () => row.Status,
      withGovernanceMutation: (_metadata, fn) => fn(),
      ensureTicketMutationOwnership: () => ({}),
      prepareDoneCloseout: () => {
        const current = attemptCoordination.readCanonical(root, { remote: "origin", ticket });
        const next = { ...current.record, generation: current.record.generation + 1, updated_at: new Date().toISOString() };
        attemptCoordination.publishCanonicalTransition(root, { remote: "origin", ticket, expected: current, next });
      },
      assertTicketFence: (id) => authority.assertTicketFence(id),
      applyMarkDone: () => { writes += 1; row.Status = "done"; },
    });
    const transitions = createTicketTransitions(deps);
    assert.ok(bootstrap.oid);
    assert.throws(() => transitions.markDone(ticket), /canonical attempt fence is stale/);
    assert.equal(writes, 0, "the fence is checked after preflight but before the DONE writer");
    assert.equal(row.Status, "review");
  });
});

const { ORCH, WORKER, withCanonicalAuthorityContext } = require("./__fixtures__/integration-authority-context.js"); // COORD-1041: shared fixture
const SCRUB = ["NODE_TEST_CONTEXT", "NODE_CHANNEL_FD", "COORD_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID",
  "AGENT_THREAD_ID", "COORD_AGENT_ID", "COORD_AGENT_HANDLE", "COORD_OWNER", "CODEX_THREAD_ID", "COORD_INTEGRATION_LEASE_MS",
  "CLAUDECODE", "GEMINI_AGENT", "GROK_AGENT"];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord915-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord");
  const repo = path.join(root, "backend");
  fs.mkdirSync(coord);
  fs.mkdirSync(repo);
  for (const name of ["scripts", "engine", "board", "paths.js", "project.config.js", "GOVERNANCE.md", "AGENTS.md", "product", "prompts", "schemas", "docs", "agents.json"]) {
    if (fs.existsSync(path.join(COORD_ROOT, name))) fs.cpSync(path.join(COORD_ROOT, name), path.join(coord, name), { recursive: true });
  }
  installCanonicalEngine(coord, COORD_ROOT);
  const write = (name, data) => {
    const target = path.join(coord, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof data === "string" ? data : JSON.stringify(data));
  };
  const config = { repos: { B: { path: "backend", integrationBranch: "dev" } } };
  write("project.config.js", `module.exports=${JSON.stringify(config)};\n`);
  const baseEnv = gitFixtureEnv();
  for (const key of SCRUB) delete baseEnv[key];
  const git = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { env: baseEnv, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  for (const dir of [repo, coord]) {
    git(dir, "init", "-b", dir === repo ? "dev" : "main");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "maintenance.autoDetach", "false");
    git(dir, "config", "gc.autoDetach", "false");
  }
  fs.writeFileSync(path.join(repo, "app.txt"), "seed\n");
  git(repo, "add", "app.txt");
  git(repo, "commit", "-m", "seed");
  const row = { ID: "TEST-001", Repo: "B", Type: "bug", Pri: "P1", Status: "todo", Owner: "", Description: "Integration authority fixture", "Depends On": "" };
  write("board/tasks.json", { version: 1, metadata: { title: "Integration", last_updated: new Date().toISOString(), canonical_references: [], plan_markdown_render_statuses: ["doing", "review"], preamble: [],
    plan_records_required_from_ticket: { B: "TEST-999" }, landing_index_required_from_ticket: { B: "TEST-999" }, pr_index_required_from_ticket: { B: "TEST-999" } },
  sections: [{ kind: "table", level: 2, heading: "Integration", separator_before: false, columns: Object.keys(row), rows: [row] }],
  prompt_index: { "TEST-001": "coord/prompts/integration.md" }, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {} });
  write("prompts/integration.md", "# Integration\n");
  write("QUESTIONS.md", "# Questions\n");
  write("PLAN.md", "");
  write(".runtime/agents.json", [WORKER, ORCH, "codexa03"].map((handle, i) => ({ id: `a0${i + 1}`, handle, provider: "openai", status: "active", aliases: [] })));
  write(".runtime/agent_sessions.json", []);
  require(path.join(coord, "board/board.js")).renderBoardArtifacts();
  write(".gitignore", ".runtime/\n");
  git(coord, "add", ".");
  git(coord, "commit", "-m", "Seed integration fixture");
  const env = (thread, extra = {}) => ({ ...baseEnv, COORD_PROJECT_CONFIG: path.join(coord, "project.config.js"), CODEX_THREAD_ID: `${thread}-${path.basename(root)}`, ...extra });
  const run = (thread, args, extra) => spawnSync(process.execPath, [path.join(coord, "scripts/governance.js"), ...args], { cwd: root, env: env(thread, extra), encoding: "utf8", timeout: 60000 });
  const ok = (thread, args, extra) => {
    const r = run(thread, args, extra);
    assert.equal(r.status, 0, `${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
    return r;
  };
  const refused = (thread, args, pattern, extra) => {
    const r = run(thread, args, extra);
    assert.notEqual(r.status, 0, `${args.join(" ")} must be refused\n${r.stdout}`);
    assert.match(r.stderr, pattern);
    return r;
  };
  const runWithSignedApproval = (thread, args, verb, ticket) => {
    const refusedAttempt = run(thread, args);
    assert.notEqual(refusedAttempt.status, 0, "an override reason alone must not authorize this operation");
    assert.match(refusedAttempt.stderr, /requires a signed human-admin approval/);
    const subject = /Subject digest: ([0-9a-f]{64})/.exec(refusedAttempt.stderr);
    assert.ok(subject, refusedAttempt.stderr);
    const approval = createApprovalFixture({ allowedVerbs: [verb] });
    try {
      approval.login({ verb, ticket, subject_sha256: subject[1] });
      return approval.runCli(coord, args, { cwd: root, env: env(thread), encoding: "utf8", timeout: 60000 });
    } finally { approval.cleanup(); }
  };
  // Signed fixture setup from an unbound thread creates no integration holder.
  // Raw run/ok/refused stay unchanged for authority and refusal assertions.
  const setupArgs = withApprovedPacket(["reconcile", "--reason", "initialize isolated COORD-915 fixture",
    "--human-admin-override", "Fixture administrator approves this isolated synthetic state"], (args) => ok("setup", args));
  const unsignedSetup = run("setup", setupArgs);
  assert.notEqual(unsignedSetup.status, 0, "fixture setup needs a real signed approval");
  assert.match(unsignedSetup.stderr, /requires a signed human-admin approval/);
  const setupSubject = /Subject digest: ([0-9a-f]{64})/.exec(unsignedSetup.stderr);
  assert.ok(setupSubject, unsignedSetup.stderr);
  const setupApproval = createApprovalFixture({ allowedVerbs: ["reconcile"] });
  try {
    setupApproval.login({ verb: "reconcile", ticket: "control-plane", subject_sha256: setupSubject[1] });
    const initialized = setupApproval.runCli(coord, setupArgs,
      { cwd: root, env: env("setup"), encoding: "utf8", timeout: 60000 });
    assert.equal(initialized.status, 0, `${setupArgs.join(" ")}\n${initialized.stdout}\n${initialized.stderr}`);
  } finally { setupApproval.cleanup(); }
  const record = () => {
    const file = path.join(coord, ".runtime", authority.RECORD_FILE);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  };
  const writeRecord = (value) => fs.writeFileSync(path.join(coord, ".runtime", authority.RECORD_FILE), JSON.stringify(value, null, 2));
  const head = () => git(coord, "rev-parse", "HEAD");
  const bind = (thread, handle) => ok(thread, ["agentid", "--owner", handle]);
  const question = (thread, from) => ["log-question", "--from", from, "--to", "human", "--question", `Q from ${thread} ${Math.random()}`, "--resolved", "no"];
  // A publication that changes canonical state: a governed write, then its commit.
  // A no-op sync changes nothing, so it grants and journals nothing.
  const publish = (thread, handle, message) => {
    ok(thread, question(thread, handle));
    return ok(thread, ["sync", "--commit", message]);
  };
  return { root, coord, repo, git, run, runWithSignedApproval, ok, refused, record, writeRecord, head, bind, question, publish, env };
}

function runWithSignedDirectApproval(approval, coordDir, verb, ticket, run) {
  let refusal = null;
  try { withApprovalTestClient(coordDir, approval.client(), run); } catch (error) { refusal = error; }
  assert.ok(refusal, "an override reason alone must not authorize the operation");
  assert.match(String(refusal.message), /requires a signed human-admin approval/);
  const subject = /Subject digest: ([0-9a-f]{64})/.exec(String(refusal.message));
  assert.ok(subject, String(refusal.message));
  approval.login({ verb, ticket, subject_sha256: subject[1] });
  return withApprovalTestClient(coordDir, approval.client(), run);
}

function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

// These direct-module tests keep the production module URL inside the measured
// checkout. The integration CLI tests below intentionally execute a copied
// engine in private workspaces; those exercise full command behavior but are
// not canonical-source coverage for the copied modules.

test("COORD-915 canonical modules: direct guard fences nested writes and settles a published operation", () => {
  withCanonicalAuthorityContext(({ root, git, sessionsPath, setThread }) => {
    assert.equal(authority.classifyCommand("verify-engine", ["--pin"]), "write", "pinning promotes verify-engine into a governed write");
    assert.equal(authority.classifyCommand("reconcile", ["--dry-run"]), "read", "dry-run reconcile remains unguarded");
    assert.equal(authority.classifyCommand("future-read-verb", []), "read", "unknown commands default to read classification");
    assert.equal(authority.guardCommand("counts", [], () => "read bypass"), "read bypass", "read commands do not enter the integration guard");
    assert.equal(authority.grantHolder({ handle: ORCH }, "scoped-test", "").reason, null, "empty grant reasons are normalized to null");
    setThread("thread-sort");
    fs.writeFileSync(sessionsPath, JSON.stringify([
      { handle: ORCH, thread_id: "thread-sort", board_path: path.join(root, "board", "tasks.json"), status: "active", session_id: "no-dates" },
      { handle: WORKER, thread_id: "thread-sort", board_path: path.join(root, "board", "tasks.json"), status: "active", session_id: "last-seen", last_seen_at: "2030-01-01" },
      { handle: ORCH, thread_id: "thread-sort", board_path: path.join(root, "board", "tasks.json"), status: "active", session_id: "claimed", claimed_at: "2025-01-01" },
    ]));
    assert.equal(authority.resolveCaller().session_id, "last-seen", "session ordering uses last-seen and claimed-at fallbacks");
    fs.writeFileSync(sessionsPath, JSON.stringify([
      { handle: WORKER, thread_id: "thread-sort", board_path: path.join(root, "board", "tasks.json"), status: "active", session_id: "last-seen", last_seen_at: "2030-01-01" },
      { handle: ORCH, thread_id: "thread-sort", board_path: path.join(root, "board", "tasks.json"), status: "active", session_id: "no-dates" },
    ]));
    assert.equal(authority.resolveCaller().session_id, "last-seen", "the empty-date fallback is applied on either comparator side");
    setThread("thread-old");
    fs.writeFileSync(sessionsPath, JSON.stringify([
      { handle: ORCH, thread_id: "thread-old", board_path: path.join(root, "board", "tasks.json"), status: "active", session_id: "session-old" },
      { handle: WORKER, thread_id: "thread-new", board_path: path.join(root, "board", "tasks.json"), status: "active", session_id: "session-new" },
    ]));
    authority.assertNoForeignOperation();
    assert.equal(authority.guardCommand("finalize", [], () => "terminal without parsed ticket"), "terminal without parsed ticket");
    assert.equal(authority.readRecord(), null, "a no-side-effect ticketless terminal call still rolls back its provisional holder");
    const nested = authority.guardCommand("finalize", ["TEST-915"], () => {
      authority.assertNoForeignOperation();
      assert.equal(authority.guardCommand("log-question", [], () => "nested write accepted"), "nested write accepted");
      fs.writeFileSync(path.join(root, "published.txt"), "published\n");
      git("add", "published.txt");
      git("commit", "-m", "publish scoped fixture");
      assert.equal(git("show", "HEAD:published.txt"), "published", "the callback published only inside the scoped git fixture");
      return "published";
    });
    assert.equal(nested, "published");
    const record = authority.readRecord();
    assert.equal(record.holder.handle, ORCH, "the identified first integration verb establishes its caller");
    assert.equal(record.operation, null, "successful publication settles the operation");
    assert.ok(record.history.some((event) => event.event === "operation-opened"));
    assert.ok(record.history.some((event) => event.event === "operation-closed"));
  });
});

test("COORD-915 canonical guard: no-op grants roll back; changed publication commits the holder session refresh", () => {
  withCanonicalAuthorityContext(({ root, git, setThread, updateSession }) => {
    setThread("thread-old");
    assert.equal(authority.guardCommand("finalize", ["TEST-915"], () => "no-op"), "no-op");
    assert.equal(authority.readRecord(), null, "a no-side-effect terminal operation leaves no provisional first grant");
    assert.throws(() => authority.guardCommand("finalize", ["TEST-915"], () => { throw new Error(""); }), (error) => error.message === "");
    assert.equal(authority.readRecord(), null, "an empty-message terminal failure rolls back its provisional first grant");

    assert.equal(authority.guardCommand("pr-merge", [], () => "no-op reconcile"), "no-op reconcile");
    assert.equal(authority.readRecord(), null, "a no-side-effect deferred integration also leaves no provisional grant");
    assert.throws(() => authority.guardCommand("pr-merge", [], () => { throw new Error("scoped publication failure"); }), /scoped publication failure/);
    assert.equal(authority.readRecord(), null, "a failed no-side-effect publication also rolls back its provisional grant");
    assert.throws(() => authority.guardCommand("pr-merge", [], () => { throw new Error(""); }), (error) => error.message === "");
    assert.equal(authority.readRecord(), null, "an error without a message still rolls back the provisional grant");

    assert.equal(authority.guardCommand("sync", [], () => "first sync"), "first sync");
    assert.equal(authority.readRecord().holder.handle, ORCH, "sync commits an implicit grant before publishing its own journal");
    assert.ok(authority.readRecord().history.some((event) => event.event === "granted" && event.granted_via === "implicit-first-integration-verb"));
    const journalBeforeFailedTerminal = authority.journalBytes();
    assert.throws(() => authority.guardCommand("finalize", ["TEST-915"], () => { throw new Error("claimed terminal failed before effects"); }), /claimed terminal failed before effects/);
    assert.equal(authority.readRecord().operation, null, "a failed terminal with an established holder leaves no operation open");
    assert.equal(authority.journalBytes(), journalBeforeFailedTerminal, "a no-side-effect terminal failure leaves the journal unchanged");

    const commands = createIntegrationCommands();
    commands.integrationCommand(["claim"]);
    updateSession("thread-old", { session_id: "session-old-refreshed" });
    assert.equal(authority.guardCommand("sync", [], () => "journal sync"), "journal sync");
    assert.equal(authority.readRecord().holder.session_id, "session-old-refreshed", "sync publishes the session refresh before its callback");
    assert.ok(authority.readRecord().history.some((event) => event.event === "holder-session-refreshed"));
    updateSession("thread-old", { session_id: "session-old-refreshed-again" });
    const published = authority.guardCommand("pr-merge", [], () => {
      fs.writeFileSync(path.join(root, "refresh-published.txt"), "published\n");
      git("add", "refresh-published.txt");
      git("commit", "-m", "publish refreshed scoped integration");
      return "published";
    });
    assert.equal(published, "published");
    const record = authority.readRecord();
    assert.equal(record.holder.session_id, "session-old-refreshed-again");
    assert.ok(record.history.some((event) => event.event === "holder-session-refreshed"));
  });
});

test("COORD-915 canonical deferred grant: pr-merge commits the first holder only after publication", () => {
  withCanonicalAuthorityContext(({ root, git, setThread }) => {
    setThread("thread-old");
    const result = authority.guardCommand("pr-merge", [], () => {
      fs.writeFileSync(path.join(root, "deferred-publication.txt"), "published\n");
      git("add", "deferred-publication.txt");
      git("commit", "-m", "publish first deferred integration");
      return "published";
    });
    assert.equal(result, "published");
    const record = authority.readRecord();
    assert.equal(record.holder.handle, ORCH);
    assert.equal(record.holder.provisional, undefined, "publication replaces the provisional holder with a journaled grant");
    assert.ok(record.history.some((event) => event.event === "granted" && event.command === "pr-merge"));
    assert.ok(fs.readFileSync(path.join(root, "deferred-publication.txt"), "utf8").includes("published"));
  });
});

test("COORD-915 canonical mutation guard: the reservation holder may write but a foreign session is refused", () => {
  withCanonicalAuthorityContext(({ commands, sessionsPath, setThread }) => {
    const context = require("./governance-context.js");
    setThread("thread-old");
    commands.integrationCommand(["claim"]);
    assert.throws(() => authority.guardCommand("pr-merge", [], () => {
      assert.equal(authority.guardCommand("log-question", [], () => "nested fenced write"), "nested fenced write");
      context.withGovernanceRuntimeLock(() => authority.assertNoForeignOperation());
      context.withGovernanceRuntimeLock(() => authority.assertNoForeignOperation({ command: "log-question" }));
      commands.integrationCommand(["handoff", "--to", WORKER, "--human-admin-override", "deferred-command fence regression"]);
      return "stale deferred command accepted";
    }), /authority changed while this executor was running/);
    assert.equal(authority.readRecord().holder.handle, WORKER, "the nested handoff remains in force after the deferred command refuses");
    setThread("thread-old");
    commands.integrationCommand(["handoff", "--to", ORCH, "--human-admin-override", "restore test holder"]);
    const record = authority.readRecord();
    const caller = authority.resolveCaller();
    setThread("thread-new");
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    fs.writeFileSync(sessionsPath, JSON.stringify(sessions.map((session) =>
      session.thread_id === "thread-new" ? { ...session, session_id: null } : session)));
    assert.throws(() => authority.guardCommand("sync", [], () => "sessionless foreign integration accepted"), /session codexa01 \(no session\)/);
    fs.writeFileSync(sessionsPath, JSON.stringify(sessions));
    assert.throws(() => authority.guardCommand("sync", [], () => "foreign integration accepted"), /held by codexa02/);
    setThread("thread-unregistered");
    assert.throws(() => authority.guardCommand("sync", [], () => "unidentified integration accepted"), /this unidentified session may own tickets/);
    setThread("thread-old");
    const operation = authority.newOperation("begin", "TEST-915", caller, "begin");
    authority.writeRecord({ ...record, operation }, { event: "operation-opened", operation: operation.id, ticket: "TEST-915" });

    assert.doesNotThrow(() => context.withGovernanceRuntimeLock(() => authority.assertNoForeignOperation({ command: "log-question" })));
    assert.equal(authority.guardCommand("log-question", [], () => "holder write accepted"), "holder write accepted");
    setThread("thread-new");
    assert.throws(() => context.withGovernanceRuntimeLock(() => authority.assertNoForeignOperation({ command: "log-question" })), /does not hold it/);
    assert.throws(() => authority.guardCommand("log-question", [], () => "foreign write accepted"), /does not hold it/);
    setThread("thread-unregistered");
    assert.throws(() => authority.guardCommand("log-question", [], () => "unidentified write accepted"), /this unidentified session does not hold it/);
    assert.doesNotThrow(() => context.withGovernanceRuntimeLock(() => authority.assertNoForeignOperation({ command: "agentid" })),
      "identity-only attribution remains permitted while an operation is open");
    assert.doesNotThrow(() => context.withGovernanceRuntimeLock(() => authority.assertNoForeignOperation({ command: "integration-handoff" })),
      "authority journal events use their own governed transaction");
  });
});

test("COORD-915 canonical integration commands: claim, handoff, recovery, and release preserve holder policy", () => {
  withCanonicalAuthorityContext(({ root, commands, sessionsPath, setThread }) => {
    const invoke = (...args) => commands.integrationCommand(args);
    assert.equal(invoke("status", "--json").established, false);
    assert.throws(() => invoke("status", "--unknown"), /Unknown flag/);
    assert.throws(() => invoke("unknown-subcommand"), /requires a subcommand/);
    setThread("thread-old");
    const caller = authority.resolveCaller();
    const noTicket = authority.newOperation("recover", null, caller, "begin");
    authority.writeRecord({ ...authority.emptyRecord(), holder: authority.grantHolder(caller, "scoped-test", "test"), operation: noTicket },
      { event: "scoped-operation-without-ticket" });
    assert.equal(invoke("status", "--json").operation.verification.ticket_status, null, "an operation without a ticket has no board status");
    fs.rmSync(authority.recordPath());
    authority.writeRecord({ ...authority.emptyRecord(), holder: authority.grantHolder({ handle: ORCH }, "scoped-test", "test") },
      { event: "scoped-unlogged-holder" });
    assert.equal(invoke("status", "--json").grant_event, null, "status exposes a holder that has no matching journal grant event");
    fs.appendFileSync(path.join(path.dirname(authority.recordPath()), "governance-events.ndjson"),
      `${JSON.stringify({ command: "integration-claim", details: { handle: ORCH } })}\n`);
    const legacyGrant = invoke("status", "--json").grant_event;
    assert.equal(legacyGrant.granted_via, null, "legacy grant events may omit granted_via");
    assert.equal(legacyGrant.session_id, null, "legacy grant events may omit session identifiers");
    fs.appendFileSync(path.join(path.dirname(authority.recordPath()), "governance-events.ndjson"),
      `${JSON.stringify({ command: "integration-claim" })}\n`);
    assert.equal(invoke("status", "--json").grant_event.command, "integration-claim", "journal rows without details are skipped in favor of the latest attributable grant");
    fs.rmSync(authority.recordPath());
    setThread("thread-unregistered");
    assert.throws(() => invoke("claim"), /needs an attributed session/);

    setThread("thread-old");
    assert.equal(invoke("recover", "--json").operation, null, "recover without an operation is a no-op");
    assert.throws(() => invoke("begin"), /requires <ticket-id>/);
    assert.throws(() => invoke("begin", "TEST-915"), /no holder; run gov integration claim/);
    assert.equal(invoke("claim", "--json").holder.handle, ORCH);
    assert.equal(invoke("claim", "--json").changed, false, "claim by the existing holder is idempotent");
    setThread("thread-new");
    assert.throws(() => invoke("claim"), /Integration authority is held by codexa02/);
    setThread("thread-old");
    assert.throws(() => invoke("handoff", "--to"), /requires a value/);
    assert.equal(invoke("begin", "TEST-915", "--json").operation.ticket, "TEST-915");
    assert.deepEqual(invoke("status", "--json").operation.verification.issues, [], "a healthy held operation reports no recovery issues");
    assert.throws(() => invoke("release"), /operation .* is open/);
    assert.throws(() => invoke("begin", "TEST-915"), /is already open/);
    assert.throws(() => authority.guardCommand("finalize", ["TEST-OTHER"], () => "wrong operation adopted"), /for TEST-915 is still open/);
    assert.throws(() => invoke("handoff"), /requires --to/);
    assert.throws(() => invoke("handoff", "--to", WORKER), /requires --human-admin-override/);

    const agentsPath = path.join(path.dirname(authority.recordPath()), "agents.json");
    const agents = JSON.parse(fs.readFileSync(agentsPath, "utf8"));
    fs.writeFileSync(agentsPath, JSON.stringify({ malformed: "not an agent list" }));
    assert.throws(() => invoke("handoff", "--to", WORKER, "--human-admin-override", "malformed agent ledger"), /not an active registered agent/);
    fs.writeFileSync(agentsPath, JSON.stringify(agents.map((agent) => agent.handle === WORKER ? { ...agent, status: "disabled" } : agent)));
    assert.throws(() => invoke("handoff", "--to", WORKER, "--human-admin-override", "disabled target"), /not an active registered agent/);
    fs.writeFileSync(agentsPath, JSON.stringify(agents));

    const handoff = invoke("handoff", "--to", WORKER, "--human-admin-override", "scoped authority test", "--json");
    assert.equal(handoff.holder.handle, WORKER);
    assert.equal(handoff.operation.requires_recovery, true);
    setThread("thread-new");
    const boardFile = path.join(path.dirname(authority.recordPath()), "..", "board", "tasks.json");
    fs.writeFileSync(boardFile, JSON.stringify({ sections: [{ rows: [{ ID: "TEST-915", Status: "doing" }] }] }));
    const status = invoke("status", "--json");
    assert.equal(status.caller_holds_authority, true);
    assert.equal(status.operation.verification.ticket_status, "doing");
    const sessionRows = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    fs.writeFileSync(sessionsPath, JSON.stringify(sessionRows.map((session) =>
      session.thread_id === "thread-new" ? { ...session, session_id: null } : session)));
    assert.equal(invoke("status", "--json").caller.session_id, null, "status supports a registered caller without a live session id");
    fs.writeFileSync(sessionsPath, JSON.stringify(sessionRows));
    assert.match(status.operation.verification.issues.join("; "), /requires recovery/);
    fs.writeFileSync(boardFile, "{ malformed");
    assert.equal(invoke("status", "--json").operation.verification.ticket_status, null, "unreadable ticket status is reported as unavailable");
    fs.writeFileSync(boardFile, JSON.stringify({ sections: [] }));
    assert.equal(invoke("status", "--json").operation.verification.ticket_status, null, "a ticket absent from the board has no status");
    fs.writeFileSync(boardFile, JSON.stringify({ sections: [{ rows: [{ ID: "TEST-915" }] }] }));
    assert.equal(invoke("status", "--json").operation.verification.ticket_status, null, "a matching board row without Status has no ticket status");
    fs.writeFileSync(boardFile, JSON.stringify({}));
    assert.equal(invoke("status", "--json").operation.verification.ticket_status, null, "a board without sections has no ticket status");
    fs.writeFileSync(boardFile, JSON.stringify({ sections: [{ heading: "Empty section" }] }));
    assert.equal(invoke("status", "--json").operation.verification.ticket_status, null, "a board section without rows has no ticket status");
    assert.equal(invoke("recover", "--json").verification.executor, "held");
    const resumed = invoke("recover", "--resume", "--json");
    assert.equal(resumed.operation.requires_recovery, false);
    assert.equal(resumed.operation.holder_handle, WORKER);
    assert.throws(() => invoke("release"), /operation .* is open/);
    assert.throws(() => invoke("recover", "--abandon"), /requires --human-admin-override/);
    assert.equal(invoke("recover", "--abandon", "--human-admin-override", "verified scoped fixture", "--json").operation, null);
    assert.equal(invoke("release", "--json").released, true);
    assert.throws(() => invoke("release"), /No integration-authority holder/);
    assert.throws(() => authority.guardCommand("pr-merge", [], () => "must not integrate"), /released by codexa01/);
    assert.equal(invoke("status", "--json").holder, null);
    assert.throws(() => invoke("begin", "TEST-915"), /does not hold integration authority/,
      "a released domain cannot begin an operation until a holder is claimed");

    setThread("thread-old");
    invoke("claim");
    invoke("begin", "TEST-915");
    const gitDir = path.join(root, ".git");
    const hiddenGitDir = path.join(root, ".git-unavailable");
    fs.renameSync(gitDir, hiddenGitDir);
    try {
      const unavailable = invoke("status", "--json").operation.verification;
      assert.equal(unavailable.head_now, null, "recovery reports an unavailable canonical HEAD when the repository metadata is absent");
      assert.equal(unavailable.canonical_dirty_paths, null, "recovery does not report a false clean tree when Git status is unavailable");
    } finally {
      fs.renameSync(hiddenGitDir, gitDir);
    }
    invoke("recover", "--abandon", "--human-admin-override", "end degraded metadata fixture", "--json");
    invoke("release");
  });
});

test("COORD-915 canonical bootstrap handoff: an admin can establish a registered holder before session binding", () => {
  withCanonicalAuthorityContext(({ sessionsPath, eventLogPath, commands, setThread }) => {
    fs.writeFileSync(sessionsPath, JSON.stringify([]));
    setThread("thread-unregistered");
    const result = commands.integrationCommand(["handoff", "--to", WORKER, "--human-admin-override", "initial authority assignment", "--json"]);
    assert.equal(result.holder.handle, WORKER);
    assert.equal(result.holder.session_id, null);
    assert.equal(result.holder.thread_id, null);
    assert.equal(result.operation, null);
    const events = fs.readFileSync(eventLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const handoff = events.at(-1);
    assert.equal(handoff.command, "integration-handoff");
    assert.equal(handoff.details.by, null, "the explicit human-admin override remains attributable even without an agent session");
    assert.equal(handoff.details.from, null);
    assert.equal(handoff.details.to, WORKER);
  });
});

test("COORD-1048: a closed-window handoff verifies a real signature without changing the bound sessions", (t) => {
  const f = fixture(t);
  const transitionPath = path.join(f.coord, "engine", "approval-transition.json");
  const transition = JSON.parse(fs.readFileSync(transitionPath, "utf8"));
  transition.window_ends_at = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(transitionPath, `${JSON.stringify(transition, null, 2)}\n`);
  f.bind("orch", ORCH);
  f.bind("worker", WORKER);
  const sessionsPath = path.join(f.coord, ".runtime", "agent_sessions.json");
  const sessionsBefore = fs.readFileSync(sessionsPath);
  const args = ["integration", "handoff", "--to", WORKER, "--human-admin-override", "reviewed closed-window handoff", "--json"];
  const result = f.runWithSignedApproval("orch", args, "integration handoff", WORKER);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).holder.handle, WORKER);
  assert.deepEqual(fs.readFileSync(sessionsPath), sessionsBefore,
    "the unsigned refusal and signed retry do not refresh either bound session");
  const events = fs.readFileSync(path.join(f.coord, ".runtime", "governance-events.ndjson"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const verified = events.find((event) => event.event === "approval.verified" && event.command === "integration handoff");
  assert.ok(verified, "the transition window is closed and a real approval is journaled");
  const handoff = events.findLast((event) => event.command === "integration-handoff");
  assert.equal(handoff.details.to_session_id, JSON.parse(sessionsBefore).find((row) => row.handle === WORKER).session_id);
  assert.equal(handoff.details.approval_subject_sha256, verified.subject_sha256);
});

test("COORD-915 canonical bootstrap compatibility: unidentified terminal verbs retain the empty-domain legacy path", () => {
  withCanonicalAuthorityContext(({ eventLogPath, setThread }) => {
    setThread("thread-unregistered");
    assert.equal(authority.guardCommand("finalize", ["TEST-915"], () => "legacy bootstrap"), "legacy bootstrap");
    assert.equal(authority.readRecord(), null, "unidentified bootstrap does not create an integration holder");
    assert.equal(fs.existsSync(eventLogPath), false, "the pre-holder legacy path records no synthetic integration event");
  });
});

test("COORD-915 canonical authority: malformed records refuse, journal failures roll back, and dead provisional holders stay masked", () => {
  withCanonicalAuthorityContext(({ runtime, commands, setThread }) => {
    const runtimeContext = require("./governance-context.js");
    setThread("thread-old");
    const recordFile = authority.recordPath();
    fs.writeFileSync(recordFile, "{ malformed");
    assert.throws(() => authority.readRecord(), /unknown schema/, "invalid JSON is treated as an unreadable authority record");
    fs.writeFileSync(recordFile, JSON.stringify({ schema: "future-schema" }));
    assert.throws(() => authority.readRecord(), /unknown schema/);
    fs.rmSync(recordFile);
    authority.writeRecord(authority.emptyRecord(), { event: "scoped-empty-domain" });
    assert.doesNotThrow(() => runtimeContext.withGovernanceRuntimeLock(() => authority.assertNoForeignOperation({ command: "log-question" })),
      "a persisted empty record without an operation does not block governed work");
    setThread("thread-unregistered");
    assert.throws(() => authority.guardCommand("sync", [], () => "unidentified integration accepted"), /has no holder and this session is unidentified/);
    fs.rmSync(recordFile);
    setThread("thread-old");
    fs.writeFileSync(recordFile, JSON.stringify({ schema: authority.SCHEMA, holder: null, operation: null }));
    assert.throws(() => authority.guardCommand("sync", [], () => "released domain integrated"), /no holder recorded/);
    fs.rmSync(recordFile);
    assert.equal(authority.guardCommand("reconcile", [], () => "ungranted repair verb"), "ungranted repair verb",
      "a repair verb in a never-held domain runs without creating a first grant");
    assert.equal(authority.readRecord(), null);
    setThread("thread-unregistered");
    assert.equal(authority.guardCommand("reconcile", [], () => "unidentified repair verb"), "unidentified repair verb",
      "repair verbs remain non-granting even when no caller is identified");
    setThread("thread-old");
    assert.doesNotThrow(() => runtimeContext.withGovernanceRuntimeLock(() => authority.assertNoForeignOperation({ command: "log-question" })));

    authority.__testing.setFaultHook((point) => {
      if (point === "record-written") throw new Error("scoped fault before journal append");
    });
    assert.throws(() => commands.integrationCommand(["claim"]), /scoped fault before journal append/);
    authority.__testing.setFaultHook(null);
    assert.equal(authority.readRecord(), null, "an unjournaled first grant is rolled back");
    assert.equal(fs.existsSync(path.join(runtime, "governance-events.ndjson")), false,
      "the failed grant did not append a journal event");

    commands.integrationCommand(["claim"]);
    const claimed = authority.readRecord();
    const caller = authority.resolveCaller();
    const operation = authority.newOperation("finalize", "TEST-915", caller, "terminal-verb");
    authority.writeRecord({ ...claimed, operation: { ...operation, holder_handle: WORKER } },
      { event: "scoped-inconsistent-holder-record" });
    const inconsistentBytes = fs.readFileSync(authority.recordPath(), "utf8");
    assert.throws(() => authority.guardCommand("sync", [], () => {
      throw new Error("an inconsistent operation holder must never reach publication");
    }), /does not hold it/);
    assert.equal(fs.readFileSync(authority.recordPath(), "utf8"), inconsistentBytes,
      "a malformed holder/operation pair is refused without rewriting the recovery evidence");
    operation.requires_recovery = true;
    const deadProvisional = { ...claimed, holder: { ...claimed.holder,
      provisional: { pid: deadPid(), host: require("node:os").hostname() } }, operation };
    authority.writeRecord(deadProvisional, { event: "scoped-provisional-operation" });
    const masked = authority.readRecord();
    assert.equal(masked.holder, null, "a dead provisional grant cannot authorize integration");
    assert.equal(masked.operation.id, operation.id, "masking the holder preserves the operation for recovery");
    assert.doesNotThrow(() => runtimeContext.withGovernanceRuntimeLock(() => authority.assertNoForeignOperation({ command: "log-question" })),
      "the recorded operation holder remains the reservation owner after a dead provisional holder is masked");
    setThread("thread-new");
    assert.throws(() => runtimeContext.withGovernanceRuntimeLock(() => authority.assertNoForeignOperation({ command: "log-question" })), /does not hold it/);
    assert.throws(() => runtimeContext.withGovernanceRuntimeLock(() => authority.assertNoForeignOperation()), /Refusing "governed write"/,
      "a foreign caller receives the default refusal label when no command metadata is supplied");
    setThread("thread-old");
    assert.ok(authority.operationIssues(masked.operation).some((issue) => issue.includes("requires recovery")));
    authority.writeRecord({ ...claimed, holder: { ...claimed.holder,
      provisional: { pid: deadPid(), host: require("node:os").hostname() } }, operation: null }, { event: "scoped-dead-first-grant" });
    assert.equal(authority.readRecord(), null, "a dead provisional first grant with no operation leaves the domain unclaimed");
  });
});

test("COORD-915 canonical recovery commands refuse live executors and non-holder recovery", () => {
  withCanonicalAuthorityContext(({ commands, setThread }) => {
    const invoke = (...args) => commands.integrationCommand(args);
    setThread("thread-old");
    invoke("claim");
    const record = authority.readRecord();
    const caller = authority.resolveCaller();
    const operation = { ...authority.newOperation("finalize", "TEST-915", caller, "terminal-verb"),
      requires_recovery: true };
    authority.writeRecord({ ...record, operation }, { event: "scoped-live-operation" });
    assert.throws(() => invoke("recover", "--resume"), /executor process .* is still running/);
    assert.throws(() => invoke("recover", "--resume", "--abandon"), /Choose one/);

    authority.writeRecord({ ...authority.readRecord(), operation: { ...operation, pid: deadPid() } },
      { event: "scoped-dead-operation" });
    setThread("thread-new");
    assert.throws(() => invoke("recover", "--resume"), /is for the holder/);
    assert.throws(() => invoke("release"), /Only the holder/);
    authority.writeRecord({ ...authority.readRecord(), operation: { ...operation, pid: deadPid(), host: "unreachable-host" } },
      { event: "scoped-unknown-executor" });
    assert.throws(() => invoke("recover", "--resume"), /whose liveness cannot be checked/);
    setThread("thread-old");
    const approval = createApprovalFixture({ allowedVerbs: ["integration recover --resume"] });
    try {
      const resume = () => invoke("recover", "--resume", "--human-admin-override", "operator verified remote process", "--json");
      assert.equal(runWithSignedDirectApproval(approval, COORD_ROOT, "integration recover --resume", "TEST-915", resume).operation.requires_recovery, false,
        "remote executor recovery requires a real signed approval");
    } finally { approval.cleanup(); }
  });
});

test("COORD-915 canonical stale executor: a handoff fences old in-process authority writes", () => {
  withCanonicalAuthorityContext(({ commands, setThread }) => {
    const context = require("./governance-context.js");
    setThread("thread-old");
    commands.integrationCommand(["claim"]);
    const record = authority.readRecord();
    const operation = authority.newOperation("finalize", "TEST-915", authority.resolveCaller(), "terminal-verb");
    authority.writeRecord({ ...record, operation }, { event: "scoped-active-operation" });
    authority.__testing.setActiveOperationId(operation.id);
    try {
      commands.integrationCommand(["handoff", "--to", WORKER, "--human-admin-override", "stale executor regression"]);
      authority.__testing.setActiveOperationId(null);
      setThread("thread-new");
      assert.throws(() => authority.guardCommand("sync", [], () => "unverified recovery integration accepted"), /needs verified recovery/);
      authority.__testing.setActiveOperationId(operation.id);
      assert.throws(() => authority.guardCommand("log-question", [], () => "stale nested write accepted"), /stale integration executor/);
      assert.throws(() => context.withGovernanceRuntimeLock(() => authority.assertNoForeignOperation({ command: "log-question" })), /stale integration executor/);
      assert.equal(authority.readRecord().holder.handle, WORKER);
      assert.equal(authority.readRecord().operation.requires_recovery, true);
    } finally {
      authority.__testing.setActiveOperationId(null);
    }
  });
});

test("COORD-915 canonical journal recovery: committed pending records settle; unjournaled records roll back", () => {
  withCanonicalAuthorityContext(({ sessionsPath, eventLogPath, setThread }) => {
    setThread("thread-old");
    authority.journaled("outer", { handle: ORCH }, () =>
      authority.journaled("nested", { handle: ORCH }, () => "nested mutation"));
    const events = fs.readFileSync(eventLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 1, "nested journaled mutations share their enclosing transaction");
    assert.equal(events[0].command, "integration-outer");

    const journalMutation = authority.__testing.getJournalMutation();
    authority.__testing.setJournalMutation(null);
    try {
      authority.journaled("lock-fallback", {}, () => {
        authority.writeRecord({ schema: authority.SCHEMA, holder: null, operation: null }, { event: "fallback-first-write" });
        authority.writeRecord({ ...authority.readRecord(), holder: { handle: ORCH } }, { event: "fallback-second-write" });
      });
      const fallback = authority.readRecord();
      assert.equal(fallback.holder.handle, ORCH);
      assert.equal(fallback.pending, undefined, "the runtime-lock fallback settles pending state");
      assert.deepEqual(fallback.history.map((item) => item.event), ["fallback-first-write", "fallback-second-write"]);
    } finally {
      authority.__testing.setJournalMutation(journalMutation);
      fs.rmSync(authority.recordPath(), { force: true });
    }

    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    sessions[0] = { ...sessions[0], claimed_at: "2018-01-01T00:00:00.000Z" };
    sessions.push({ handle: "codexa03", thread_id: "thread-old", session_id: "session-inactive", board_path: path.dirname(sessionsPath) + "/../board/tasks.json",
      status: "inactive", last_seen_at: "2099-01-01T00:00:00.000Z" });
    sessions.push({ handle: WORKER, thread_id: "thread-old", session_id: "session-active-newest", board_path: sessions[0].board_path,
      status: "active", last_seen_at: "2099-01-01T00:00:00.000Z" });
    sessions.push({ handle: "codexa03", thread_id: "thread-old", session_id: "session-active-older", board_path: sessions[0].board_path,
      status: "active", last_seen_at: "2020-01-01T00:00:00.000Z" });
    fs.writeFileSync(sessionsPath, JSON.stringify(sessions));
    assert.equal(authority.resolveCaller().session_id, "session-active-newest", "active attribution takes precedence over a newer inactive session");
    const missingIdSessions = sessions.map((session) => session.thread_id === "thread-old" ? { ...session, session_id: null } : session);
    fs.writeFileSync(sessionsPath, JSON.stringify(missingIdSessions));
    assert.equal(authority.resolveCaller().session_id, null, "a bound thread without a session id remains attributed but sessionless");
    fs.writeFileSync(sessionsPath, JSON.stringify(sessions));
    authority.__testing.setSessionReaders({ resolveEffectiveThreadId: () => { throw new Error("reader unavailable"); } });
    assert.equal(authority.resolveCaller(), null, "a failed thread reader remains unidentified");
    authority.__testing.setSessionReaders({ resolveEffectiveThreadId: () => "thread-not-registered" });
    assert.equal(authority.resolveCaller(), null, "an unregistered thread remains unidentified");
    authority.__testing.setSessionReaders(null);
    assert.equal(authority.resolveCaller(), null, "absence of a bound thread reader remains unidentified");
    authority.__testing.setSessionReaders({ resolveEffectiveThreadId: () => "thread-old" });
    fs.writeFileSync(sessionsPath, JSON.stringify({ invalid: "not an array" }));
    assert.equal(authority.resolveCaller(), null, "a non-array session ledger cannot identify a caller");
    fs.writeFileSync(sessionsPath, JSON.stringify(sessions));

    const oldLease = process.env.COORD_INTEGRATION_LEASE_MS;
    process.env.COORD_INTEGRATION_LEASE_MS = "1500";
    try {
      const leaseOperation = authority.newOperation("recover", null, authority.resolveCaller(), "begin");
      assert.equal(Date.parse(leaseOperation.lease_expires_at) - Date.parse(leaseOperation.started_at), 1500);
      assert.match(authority.describeOperation(leaseOperation), /\(no ticket\)/);
      assert.deepEqual(authority.operationIssues(null), []);
      assert.ok(authority.operationIssues({ ...leaseOperation, lease_expires_at: "2000-01-01T00:00:00.000Z" }).some((issue) => issue.includes("lease expired")));
      assert.ok(authority.operationIssues({ ...leaseOperation, status: "interrupted", lease_expires_at: "2999-01-01T00:00:00.000Z" }).some((issue) => issue.includes("unknown failure")));
    } finally {
      if (oldLease === undefined) delete process.env.COORD_INTEGRATION_LEASE_MS;
      else process.env.COORD_INTEGRATION_LEASE_MS = oldLease;
    }

    const claimed = { schema: authority.SCHEMA, holder: { handle: ORCH }, operation: null, history: [] };
    fs.writeFileSync(authority.recordPath(), JSON.stringify({ ...claimed, holder: null,
      pending: { txn: "unlogged-pending", event: "release", prior: claimed } }));
    assert.equal(authority.readRecord().holder.handle, ORCH, "missing journal evidence rolls the pending mutation back to its prior holder");

    fs.writeFileSync(authority.recordPath(), JSON.stringify({ ...claimed, holder: null,
      pending: { txn: "logged-pending", event: "release", prior: claimed } }));
    fs.appendFileSync(eventLogPath, `${JSON.stringify({ command: "integration-release", details: { txn: "logged-pending" } })}\n`);
    assert.equal(authority.readRecord().holder, null, "a journaled pending mutation commits and clears its marker");
    assert.equal(authority.readRecord().pending, undefined);
  });
});

test("COORD-915 canonical journal recovery: unavailable inspection preserves pending bytes; unrelated events roll back", () => {
  withCanonicalAuthorityContext(() => {
    const recordPath = authority.recordPath();
    const pending = { schema: authority.SCHEMA, holder: null, operation: null, history: [], pending: { txn: "txn-uninspectable", prior: null } };
    fs.writeFileSync(recordPath, `${JSON.stringify(pending, null, 2)}\n`);
    const before = fs.readFileSync(recordPath);
    const previousReader = authority.__testing.getJournalReader();
    try {
      authority.__testing.setJournalReader(null);
      assert.throws(() => authority.readRecord(), /cannot inspect governance journal events/);
      assert.deepEqual(fs.readFileSync(recordPath), before, "an unavailable reader must not settle or rewrite pending authority");

      authority.__testing.setJournalReader(() => [null, {}, { details: null }, { details: { txn: "another-transaction" } }]);
      assert.equal(authority.readRecord(), null, "null and unrelated events do not prove this transaction committed");
      assert.equal(fs.existsSync(recordPath), false, "an inspected journal without this transaction rolls back the pending record");
    } finally {
      authority.__testing.setJournalReader(previousReader);
    }
  });
});

test("COORD-915 canonical terminal settlement: adopt begin reservations and preserve recovery after published failures", () => {
  withCanonicalAuthorityContext(({ root, commands, setThread, updateSession, git }) => {
    setThread("thread-old");
    commands.integrationCommand(["claim"]);
    const reserved = commands.integrationCommand(["begin", "TEST-915", "--json"]).operation;
    assert.throws(() => authority.guardCommand("finalize", ["TEST-OTHER"], () => "mismatched terminal accepted"), /for TEST-915 is still open/);
    assert.throws(() => authority.guardCommand("finalize", ["TEST-915"], () => { throw new Error("no-side-effect terminal failure"); }), /no-side-effect terminal failure/);
    assert.equal(authority.readRecord().operation.id, reserved.id, "failure before side effects restores the pre-existing begin reservation");
    updateSession("thread-old", { session_id: "session-refreshed-before-terminal" });
    assert.equal(authority.guardCommand("finalize", ["TEST-915"], () => "adopted reservation"), "adopted reservation");
    assert.equal(authority.readRecord().operation, null, "a successful terminal verb adopts and closes the begin reservation");
    assert.equal(authority.readRecord().holder.session_id, "session-refreshed-before-terminal", "terminal settlement commits the holder session refresh");
    assert.ok(authority.readRecord().history.some((event) => event.event === "operation-adopted" && event.operation === reserved.id));

    assert.throws(() => authority.guardCommand("finalize", ["TEST-915"], () => {
      fs.writeFileSync(path.join(root, "partial-publication.txt"), "published then failed\n");
      git("add", "partial-publication.txt");
      git("commit", "-m", "partial terminal publication");
      throw new Error("failure after canonical publication");
    }), /failure after canonical publication/);
    const interrupted = authority.readRecord();
    assert.equal(interrupted.operation.status, "interrupted");
    assert.equal(interrupted.operation.interrupted_reason, "failure after canonical publication");
    assert.throws(() => authority.guardCommand("sync", [], () => "unrecovered operation integrated"), /needs verified recovery/);
  });
});

test("COORD-915: every dispatched verb has an integration class, so a new canonical-writing verb cannot skip the reservation", () => {
  const verbs = [...require("./verb-parity.js").collectDispatchCommandVerbs(fs.readFileSync(path.join(__dirname, "cli.js"), "utf8"))];
  assert.ok(verbs.length >= 100);
  const classified = Object.values(authority.VERB_CLASSES).flat();
  assert.deepEqual(verbs.filter((verb) => !classified.includes(verb)), [], "classify each new verb in VERB_CLASSES");
  assert.deepEqual(classified.filter((verb) => !verbs.includes(verb)), [], "VERB_CLASSES names a verb the router no longer dispatches");
  assert.equal(new Set(classified).size, classified.length, "a verb has exactly one class");
  assert.equal(authority.classifyCommand("test-policy", ["except"]), "write", "test-policy exceptions write governed board metadata");
  for (const verb of ["sync", "publish-board", "land", "close", "finish", "finalize", "mark-done", "finish-ticket", "reconcile", "pr-merge", "supersede", "rebuild-board"]) {
    assert.equal(authority.classifyCommand(verb, []), "integration", verb);
  }
  assert.equal(authority.classifyCommand("integration", ["claim"]), "authority");
});

test("COORD-915: flags that make a read verb write promote its class", () => {
  assert.equal(authority.classifyCommand("doctor", []), "read");
  assert.equal(authority.classifyCommand("doctor", ["--fix"]), "write");
  assert.equal(authority.classifyCommand("audit-landings", ["--write"]), "integration");
  assert.equal(authority.classifyCommand("verify-engine", ["--pin"]), "write");
  assert.equal(authority.classifyCommand("reconcile", ["--dry-run"]), "read");
  assert.equal(authority.classifyCommand("no-such-verb", []), "read");
  assert.equal(authority.classifyCommand("agentid", ["--owner", "x"]), "identity");
});

test("COORD-915: operation issues name interruption, recovery, a gone executor and an expired lease", () => {
  assert.deepEqual(authority.operationIssues(null), []);
  const base = { pid: null, host: os.hostname(), status: "open", lease_expires_at: new Date(Date.now() + 60000).toISOString() };
  assert.equal(authority.executorState(base), "held");
  assert.deepEqual(authority.operationIssues(base), []);
  assert.equal(authority.executorState({ ...base, pid: process.pid }), "live");
  assert.equal(authority.executorState({ ...base, pid: 1, host: "elsewhere" }), "unknown");
  const issues = authority.operationIssues({ ...base, pid: deadPid(), status: "interrupted", interrupted_reason: "boom", requires_recovery: true, lease_expires_at: new Date(0).toISOString() });
  assert.equal(issues.length, 4);
  assert.match(issues.join("\n"), /interrupted: boom[\s\S]*requires recovery[\s\S]*stale executor[\s\S]*lease expired/);
});

test("COORD-915: the integration subcommand parser refuses unknown flags and valueless options", () => {
  assert.deepEqual(parseArgs(["T-1", "--json", "--to", "a", "--human-admin-override", "why"]), { positional: ["T-1"], json: true, to: "a", override: "why" });
  assert.throws(() => parseArgs(["--to"]), /--to requires a value/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown flag "--bogus"/);
});

test("COORD-915 incident: a second session cannot sync or commit another orchestrator's pending state", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.publish("orch", ORCH, "orchestrator publishes");
  assert.equal(f.record().holder.handle, ORCH);
  assert.equal(f.record().holder.granted_via, "implicit-first-integration-verb");
  // The orchestrator's PR is merged; it reserves the integration before finalize.
  f.ok("orch", ["integration", "begin", "TEST-001"]);
  f.bind("remote", WORKER);
  const before = f.head();
  for (const args of [["sync", "--commit", "remote publishes"], ["sync"], ["finalize", "TEST-001"], ["reconcile", "--reason", "remote"]]) {
    const r = f.refused("remote", args, new RegExp(`held by ${ORCH}`));
    assert.match(r.stderr, /gov integration handoff --to <handle> --human-admin-override/);
  }
  // Any governed write by the other session is refused while the operation is open.
  f.refused("remote", f.question("remote", WORKER), /integration operation iop-[\s\S]*is open/);
  assert.equal(f.head(), before, "no canonical commit was made by the second session");
  assert.equal(f.record().operation.ticket, "TEST-001");
});

test("COORD-915: sync refuses publication when authority changes after regeneration", async (t) => {
  const f = fixture(t);
  f.bind("old", ORCH);
  f.ok("old", ["integration", "claim"]);
  f.ok("old", f.question("old", ORCH));
  f.bind("new", WORKER);
  const initialHead = f.head();
  f.ok("old", ["sync", "--commit", "same-holder sync publication"]);
  assert.notEqual(f.head(), initialHead, "a current holder can still publish a governed sync");
  f.ok("old", f.question("old", ORCH));

  const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord915-sync-barrier-"));
  t.after(() => fs.rmSync(barrierDir, { recursive: true, force: true }));
  const hit = path.join(barrierDir, "hit");
  const release = path.join(barrierDir, "release");
  const bin = path.join(barrierDir, "bin");
  fs.mkdirSync(bin);
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const wrapper = path.join(bin, "git");
  fs.writeFileSync(wrapper, `#!/bin/sh\ncase "$*" in\n  *"status --porcelain=v1 -uall"*)\n    : > "$SYNC_BARRIER_HIT"\n    while [ ! -e "$SYNC_BARRIER_RELEASE" ]; do sleep 0.01; done\n    ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const before = f.head();
  const env = f.env("old", {
    PATH: `${bin}:${process.env.PATH}`,
    SYNC_BARRIER_HIT: hit,
    SYNC_BARRIER_RELEASE: release,
  });
  const child = spawn(process.execPath, [path.join(f.coord, "scripts/governance.js"), "sync", "--commit", "stale sync publication"], {
    cwd: f.root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const waitForFile = (file, label) => {
    const until = Date.now() + 30000;
    while (!fs.existsSync(file) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    assert.ok(fs.existsSync(file), `timed out waiting for ${label}`);
  };
  try {
    waitForFile(hit, "sync delta computation after the governed mutation");
    f.ok("new", ["integration", "handoff", "--to", WORKER, "--human-admin-override", "sync publication race regression"]);
    assert.equal(f.record().holder.handle, WORKER, "the concurrent handoff is durable before publication resumes");
  } finally {
    fs.writeFileSync(release, "resume\n");
  }
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.notEqual(result.code, 0, `stale sync unexpectedly succeeded\n${stdout}\n${stderr}`);
  assert.match(stderr, /integration authority changed while this executor was running/);
  assert.equal(f.head(), before, "the stale sync did not create a Git commit after handoff");
  assert.equal(f.git(f.coord, "diff", "--cached", "--quiet") || "", "", "the stale sync did not stage its delta");
  assert.equal(f.record().holder.handle, WORKER, "the old sync cannot restore or overwrite the new holder");
});

test("COORD-915: sync publication fence covers terminal operations and refuses an unfenced caller", () => {
  withCanonicalAuthorityContext(({ root, git, setThread }) => {
    setThread(null);
    assert.equal(authority.withActiveCommandFence("sync", () => "legacy bootstrap publication"), "legacy bootstrap publication",
      "the original no-holder, unidentified bootstrap contract remains available");
    setThread("thread-old");
    assert.throws(() => authority.withActiveCommandFence("sync", () => "unfenced publication"), /requires an active integration executor/);

    const boardPath = path.join(root, "board", "tasks.json");
    fs.mkdirSync(path.dirname(boardPath), { recursive: true });
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [], prompt_index: {} }));
    git("add", "board/tasks.json");
    git("commit", "-m", "seed sync publication guard fixture");
    const syncService = require("./sync-provenance.js")({
      COORD_DIR: root,
      DEFAULT_PATHS: { boardPath },
      gitTry: (repoRoot, args) => spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }),
    });
    const before = git("rev-parse", "HEAD");
    assert.throws(() => syncService.commitCanonicalDelta(root, "unfenced module publication", ["seed.txt"]),
      /requires an active integration executor/,
      "the sync factory's production default must use the authority fence");
    assert.equal(git("rev-parse", "HEAD"), before, "the real default rejects before creating a commit");
    assert.equal(git("diff", "--cached", "--quiet"), "", "the real default rejects before staging files");

    let pushCalls = 0;
    const result = authority.guardCommand("finalize", ["TEST-915"], () =>
      syncService.pushAfterLifecycleSync({ verb: "finalize", repoRoot: root, pushFn: () => { pushCalls += 1; return { status: 0 }; } }));
    assert.equal(result.pushed, true, "the open terminal operation authorizes its post-sync remote publication");
    assert.equal(pushCalls, 1, "the real sync factory fence reaches the authorized push callback");
    assert.equal(authority.readRecord(), null, "successful no-side-effect terminal work settles its operation and provisional grant");
  });
});

test("COORD-915: a deferred integration executor can nest the active sync publication fence", () => {
  withCanonicalAuthorityContext(({ commands, setThread }) => {
    setThread("thread-old");
    commands.integrationCommand(["claim"]);
    const result = authority.guardCommand("pr-merge", [], () =>
      authority.withActiveCommandFence("sync", () => "authorized nested publication"));
    assert.equal(result, "authorized nested publication");
    assert.equal(authority.readRecord().holder.handle, ORCH, "the nested fence preserves the integration holder");
  });
});

test("COORD-915: an assigned worker edits its isolated worktree without gaining publication authority", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  f.bind("worker", WORKER);
  const worktree = path.join(f.repo, ".worktrees", WORKER, "TEST-001");
  f.git(f.repo, "worktree", "add", "-b", "agent/codexa01-test-001", worktree);
  fs.writeFileSync(path.join(worktree, "app.txt"), "worker change\n");
  f.git(worktree, "commit", "-am", "TEST-001: worker change");
  f.ok("worker", f.question("worker", WORKER));
  f.refused("worker", ["sync", "--commit", "worker publishes"], new RegExp(`held by ${ORCH}[\\s\\S]*may own tickets and edit its worktree`));
  f.refused("worker", ["mark-done", "TEST-001"], new RegExp(`held by ${ORCH}`));
  assert.equal(f.record().holder.handle, ORCH);
});

test("COORD-915: registration alone does not grant integration authority", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  f.ok("orch", ["integration", "claim"]);
  f.bind("newcomer", "codexa03");
  const status = JSON.parse(f.ok("newcomer", ["integration", "status", "--json"]).stdout);
  assert.equal(status.holder.handle, ORCH);
  assert.equal(status.caller.handle, "codexa03");
  assert.equal(status.caller_holds_authority, false);
  f.refused("newcomer", ["integration", "claim"], new RegExp(`held by ${ORCH}`));
  f.refused("newcomer", ["integration", "release"], /Only the holder/);
  f.refused("newcomer", ["integration", "begin", "TEST-001"], /does not hold integration authority/);
  f.refused("newcomer", ["reconcile", "--reason", "x"], new RegExp(`held by ${ORCH}`));
  // An unbound thread is not attributed at all.
  f.refused("stranger", ["sync", "--commit", "x"], /this unidentified session/);
  f.refused("stranger", ["integration", "claim"], /needs an attributed session/);
  // Release, then the domain needs an explicit claim.
  f.ok("orch", ["integration", "release"]);
  f.refused("newcomer", ["sync", "--commit", "x"], /has no holder \(released by[\s\S]*gov integration claim/);
  f.refused("stranger", ["sync", "--commit", "x"], /has no holder and this session is unidentified/);
  f.ok("newcomer", ["integration", "claim"]);
  assert.equal(f.record().holder.handle, "codexa03");
  assert.equal(f.record().holder.granted_via, "claim");
});

test("COORD-915: interruption and takeover preserve the unfinished operation and require verified recovery", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  f.ok("orch", ["integration", "begin", "TEST-001"]);
  f.refused("orch", ["integration", "begin", "TEST-001"], /already open/);
  f.refused("orch", ["integration", "release"], /is open/);
  f.bind("next", WORKER);
  f.refused("next", ["integration", "handoff", "--to", WORKER], /requires --human-admin-override/);
  f.refused("next", ["integration", "handoff", "--to", "nobody", "--human-admin-override", "x"], /not an active registered agent/);
  f.ok("next", ["integration", "handoff", "--to", WORKER, "--human-admin-override", "orchestrator unavailable; human admin hands over"]);
  const handed = f.record();
  assert.equal(handed.holder.handle, WORKER);
  assert.equal(handed.holder.granted_via, "handoff");
  assert.equal(handed.operation.requires_recovery, true, "the unfinished operation is preserved");
  f.refused("next", ["sync", "--commit", "x"], /needs verified recovery[\s\S]*requires recovery/);
  // The reservation follows the domain holder: the previous holder may no longer write.
  f.refused("orch", f.question("orch", ORCH), /integration operation iop-[\s\S]*is open/);
  f.ok("next", f.question("next", WORKER));
  f.refused("orch", ["sync", "--commit", "x"], new RegExp(`held by ${WORKER}`));
  const report = JSON.parse(f.ok("next", ["integration", "recover", "--json"]).stdout);
  assert.equal(report.verification.ticket, "TEST-001");
  assert.equal(report.verification.executor, "held");
  f.refused("orch", ["integration", "recover", "--resume"], /is for the holder/);
  f.refused("next", ["integration", "recover", "--resume", "--abandon", "--human-admin-override", "x"], /Choose one/);
  f.ok("next", ["integration", "recover", "--resume"]);
  assert.equal(f.record().operation.requires_recovery, false);
  assert.equal(f.record().operation.holder_handle, WORKER);
  f.ok("next", ["sync", "--commit", "new holder publishes"]);
  f.refused("next", ["integration", "recover", "--abandon"], /requires --human-admin-override/);
  f.ok("next", ["integration", "recover", "--abandon", "--human-admin-override", "verified: nothing left to publish"]);
  assert.equal(f.record().operation, null);
  f.ok("next", ["integration", "recover"]);
  const events = fs.readFileSync(path.join(f.coord, ".runtime", "governance-events.ndjson"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  for (const command of ["integration-claim", "integration-begin", "integration-handoff", "integration-recover"]) {
    assert.ok(events.some((e) => e.command === command), `${command} is journaled`);
  }
});

test("COORD-915: a crash mid-operation leaves a recorded operation that only verified recovery clears", async (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  // A real process opens a finalize operation and dies inside it.
  const script = `
    const ia = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-authority.js"))});
    require(${JSON.stringify(path.join(f.coord, "engine/scripts/cli.js"))});
    ia.guardCommand("finalize", ["TEST-001"], () => { ${holdStatement(f, "mid-operation")} });`;
  const crash = await crashChild(f, "orch", script);
  assertCrashed(crash, "mid-operation");
  const op = f.record().operation;
  assert.equal(op.ticket, "TEST-001");
  assert.equal(op.verb, "finalize");
  assert.equal(authority.executorState(op), "gone");
  f.refused("orch", ["finalize", "TEST-001"], /needs verified recovery[\s\S]*stale executor/);
  f.bind("other", WORKER);
  f.refused("other", ["integration", "recover", "--resume"], /is for the holder/);
  f.ok("orch", ["integration", "recover", "--resume"]);
  assert.equal(f.record().operation.pid, null);
});

test("COORD-915: a live or unknown executor and an expired lease never authorize takeover", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  f.ok("orch", ["integration", "begin", "TEST-001"], { COORD_INTEGRATION_LEASE_MS: "1" });
  // Expired: the holder itself must verify before integrating again ...
  f.refused("orch", ["sync", "--commit", "x"], /lease expired/);
  // ... and expiry gives another session nothing.
  f.bind("other", WORKER);
  f.refused("other", ["sync", "--commit", "x"], new RegExp(`held by ${ORCH}`));
  f.refused("other", f.question("other", WORKER), /is open/);
  f.refused("other", ["integration", "recover", "--resume"], /is for the holder/);
  const rec = f.record();
  f.writeRecord({ ...rec, operation: { ...rec.operation, pid: process.pid, host: os.hostname() } });
  f.refused("orch", ["integration", "recover", "--resume"], /still running on this host/);
  f.refused("orch", ["integration", "recover", "--abandon", "--human-admin-override", "x"], /still running on this host/);
  f.writeRecord({ ...rec, operation: { ...rec.operation, pid: deadPid(), host: "another-host" } });
  const resumeArgs = ["integration", "recover", "--resume", "--human-admin-override", "verified the remote executor stopped", "--json"];
  const bareOverride = f.refused("orch", resumeArgs, /requires a signed human-admin approval/);
  const oldSubject = /Subject digest: ([0-9a-f]{64})/.exec(bareOverride.stderr);
  assert.ok(oldSubject, bareOverride.stderr);
  const beforeChangedState = f.record();
  const changedOperation = { ...beforeChangedState.operation, approval_fixture_marker: "changed-after-review" };
  f.writeRecord({ ...beforeChangedState, operation: changedOperation });
  const approval = createApprovalFixture({ allowedVerbs: ["integration recover --resume"] });
  try {
    approval.login({ verb: "integration recover --resume", ticket: "TEST-001", subject_sha256: oldSubject[1] });
    const staleApproval = approval.runCli(f.coord, resumeArgs,
      { cwd: f.root, env: f.env("orch"), encoding: "utf8", timeout: 60000 });
    assert.notEqual(staleApproval.status, 0, "a signature over the pre-change operation cannot authorize recovery");
    assert.match(staleApproval.stderr, /refused: scope-mismatch/);
    const newSubject = /Subject digest: ([0-9a-f]{64})/.exec(staleApproval.stderr);
    assert.ok(newSubject, staleApproval.stderr);
    assert.deepEqual(f.record().operation, changedOperation, "a stale approval leaves the changed operation untouched");
    approval.login({ verb: "integration recover --resume", ticket: "TEST-001", subject_sha256: newSubject[1] });
    const signedResume = approval.runCli(f.coord, resumeArgs,
      { cwd: f.root, env: f.env("orch"), encoding: "utf8", timeout: 60000 });
    assert.equal(signedResume.status, 0, `${resumeArgs.join(" ")}\n${signedResume.stdout}\n${signedResume.stderr}`);
    assert.equal(JSON.parse(signedResume.stdout).operation.requires_recovery, false);
    const events = fs.readFileSync(path.join(f.coord, ".runtime", "governance-events.ndjson"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(events.some((event) => event.event === "approval.verified" && event.command === "integration recover --resume"));
    const recoveryEvent = events.findLast((event) => event.command === "integration-recover");
    assert.equal(recoveryEvent.details.approval_subject_sha256, newSubject[1]);
    assert.ok(recoveryEvent.details.approval_record);
  } finally { approval.cleanup(); }
  f.ok("orch", ["sync", "--commit", "holder publishes after recovery"]);
});

test("COORD-915: a terminal verb that fails before any side effect leaves no operation behind", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  const r = f.run("orch", ["finalize", "TEST-001"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /has no PR evidence/);
  const rec = f.record();
  assert.equal(rec.operation, null);
  assert.equal(rec.history.at(-1).event, "operation-aborted-before-side-effects");
  f.ok("orch", ["sync", "--commit", "holder publishes after a refused finalize"]);
});

test("COORD-915: independent clones with their own runtime remain independently owned", (t) => {
  const a = fixture(t);
  const b = fixture(t);
  a.bind("orch", ORCH);
  a.publish("orch", ORCH, "clone A publishes");
  b.bind("worker", WORKER);
  b.publish("worker", WORKER, "clone B publishes");
  assert.equal(a.record().holder.handle, ORCH);
  assert.equal(b.record().holder.handle, WORKER);
  a.ok("orch", ["integration", "begin", "TEST-001"]);
  b.ok("worker", b.question("worker", WORKER));
});

test("COORD-915: an unreadable record refuses integration instead of granting it", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  fs.writeFileSync(path.join(f.coord, ".runtime", authority.RECORD_FILE), "{not json");
  f.refused("orch", ["sync", "--commit", "x"], /unreadable or has an unknown schema/);
});

function runGuarded(f, thread, verb, body) {
  const script = `
    const ia = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-authority.js"))});
    require(${JSON.stringify(path.join(f.coord, "engine/scripts/cli.js"))});
    const { execFileSync } = require("node:child_process");
    try { console.log(JSON.stringify(ia.guardCommand(${JSON.stringify(verb)}, ["TEST-001"], () => { ${body} }))); }
    catch (error) { console.error(error.message); process.exit(3); }`;
  return spawnSync(process.execPath, ["-e", script], { cwd: f.root, env: f.env(thread), encoding: "utf8" });
}

function startPausedCommand(f, thread, verb, body) {
  const startedPath = path.join(f.root, `terminal-${thread}.started`);
  const releasePath = path.join(f.root, `terminal-${thread}.release`);
  const script = `
    const fs = require("node:fs");
    const ia = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-authority.js"))});
    const cli = require(${JSON.stringify(path.join(f.coord, "engine/scripts/cli.js"))});
    try {
      ia.guardCommand(${JSON.stringify(verb)}, ["TEST-001"], () => {
        fs.writeFileSync(${JSON.stringify(startedPath)}, "ready");
        const waitCell = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 30000;
        while (!fs.existsSync(${JSON.stringify(releasePath)})) {
          if (Date.now() >= deadline) throw new Error("test handoff release timed out");
          Atomics.wait(waitCell, 0, 0, 20);
        }
        ${body}
      });
      process.exit(0);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(3);
    }`;
  const child = require("node:child_process").spawn(process.execPath, ["-e", script], {
    cwd: f.root,
    env: f.env(thread),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let exited = false;
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.on("close", (status) => {
    exited = true;
    resolve({ status, stderr });
  }));
  const started = new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const poll = () => {
      if (fs.existsSync(startedPath)) return resolve();
      if (child.exitCode !== null) return reject(new Error(`terminal exited before reservation: ${stderr}`));
      if (Date.now() >= deadline) return reject(new Error(`terminal did not reserve within timeout: ${stderr}`));
      setTimeout(poll, 10);
    };
    poll();
  });
  return {
    started,
    closed,
    release() {
      if (exited) return;
      if (!fs.existsSync(path.dirname(releasePath))) {
        child.kill("SIGTERM");
        return;
      }
      fs.writeFileSync(releasePath, "continue");
    },
  };
}

test("COORD-915: a terminal verb adopts the reserved operation and closes it after publication", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  f.ok("orch", ["integration", "begin", "TEST-001"]);
  const opId = f.record().operation.id;
  const r = runGuarded(f, "orch", "finalize", "return 'published';");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout), "published");
  const rec = f.record();
  assert.equal(rec.operation, null);
  const events = rec.history.filter((e) => e.operation === opId).map((e) => e.event);
  assert.deepEqual(events, ["operation-opened", "operation-adopted", "operation-closed"]);
  // A terminal verb for another ticket cannot interleave with an open reservation.
  f.ok("orch", ["integration", "begin", "TEST-001"]);
  const other = f.run("orch", ["finalize", "TEST-002"]);
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /operation iop-[\s\S]* for TEST-001 is still open/);
});

test("COORD-915: a terminal verb that fails after a canonical side effect stays recorded as interrupted", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  const body = `execFileSync("git", ["-C", ${JSON.stringify(f.coord)}, "commit", "--allow-empty", "-m", "landing"]); throw new Error("push rejected");`;
  const r = runGuarded(f, "orch", "land", body);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /push rejected/);
  const op = f.record().operation;
  assert.equal(op.status, "interrupted");
  assert.equal(op.interrupted_reason, "push rejected");
  f.refused("orch", ["land", "TEST-001"], /needs verified recovery[\s\S]*interrupted: push rejected/);
  const report = JSON.parse(f.ok("orch", ["integration", "recover", "--json"]).stdout);
  assert.equal(report.verification.head_moved, true);
  f.ok("orch", ["integration", "recover", "--resume"]);
});

test("COORD-915 repair race: handoff fences a live terminal executor's nested governed write", async (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  f.bind("next", WORKER);
  const runner = startPausedCommand(f, "orch", "finalize",
    `cli.__testing.dispatchCommand("log-question", ["--from", ${JSON.stringify(ORCH)}, "--to", "human", "--question", "old executor post-handoff write", "--resolved", "no"]);`);
  t.after(() => runner.release());
  await runner.started;
  f.ok("next", ["integration", "handoff", "--to", WORKER, "--human-admin-override", "test fences active terminal executor"]);
  runner.release();
  const result = await runner.closed;
  assert.notEqual(result.status, 0, "the former holder's nested governed write is refused after handoff");
  assert.match(result.stderr, /integration operation|integration authority/);
  const record = f.record();
  assert.equal(record.holder.handle, WORKER);
  assert.equal(record.operation.requires_recovery, true);
  assert.doesNotMatch(fs.readFileSync(path.join(f.coord, "QUESTIONS.md"), "utf8"), /old executor post-handoff write/, "the attempted question must not be written");
  f.refused("next", ["sync", "--commit", "x"], /needs verified recovery/);
});

test("COORD-915 repair race: successful no-op settlement preserves a handoff reservation", async (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  f.bind("next", WORKER);
  const runner = startPausedCommand(f, "orch", "finalize", "return \"terminal callback completed without ticket-side effects\";");
  t.after(() => runner.release());
  await runner.started;
  f.ok("next", ["integration", "handoff", "--to", WORKER, "--human-admin-override", "test preserves handoff recovery after no-op"]);
  runner.release();
  const result = await runner.closed;
  assert.notEqual(result.status, 0, "the old executor cannot settle after a handoff");
  assert.match(result.stderr, /integration authority changed|integration operation/);
  const record = f.record();
  assert.equal(record.holder.handle, WORKER);
  assert.ok(record.operation, "the old callback cannot close the handed-off operation");
  assert.equal(record.operation.requires_recovery, true);
  f.refused("next", ["sync", "--commit", "x"], /needs verified recovery/);
});

test("COORD-915 repair race: failed refreshed executor cannot overwrite the new holder session", async (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.publish("orch", ORCH, "initial holder session publishes");
  const originalSession = f.record().holder.session_id;
  f.ok("orch", ["agent-release", ORCH]);
  f.bind("orch-new", ORCH);
  const newOrchestratorSession = JSON.parse(fs.readFileSync(path.join(f.coord, ".runtime", "agent_sessions.json"), "utf8"))
    .find((session) => session.thread_id === `orch-new-${path.basename(f.root)}`).session_id;
  assert.notEqual(newOrchestratorSession, originalSession);
  f.bind("next", WORKER);
  const runner = startPausedCommand(f, "orch-new", "finalize", "throw new Error(\"terminal failed after handoff\");");
  t.after(() => runner.release());
  await runner.started;
  f.ok("next", ["integration", "handoff", "--to", WORKER, "--human-admin-override", "test fences stale session refresh"]);
  const handedSession = f.record().holder.session_id;
  assert.notEqual(handedSession, newOrchestratorSession);
  runner.release();
  const result = await runner.closed;
  assert.notEqual(result.status, 0);
  const record = f.record();
  assert.equal(record.holder.handle, WORKER);
  assert.equal(record.holder.session_id, handedSession, "the stale executor cannot refresh the handoff target from its own session");
  assert.equal(record.operation.requires_recovery, true);
});

test("COORD-915 repair race: a nonterminal pr-merge executor cannot write after handing off", async (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.publish("orch", ORCH, "initial holder session publishes");
  const runner = startPausedCommand(f, "orch", "pr-merge",
    `cli.__testing.dispatchCommand("integration", ["handoff", "--to", ${JSON.stringify(WORKER)}, "--human-admin-override", "handoff inside pr-merge executor"]);\n        cli.__testing.dispatchCommand("log-question", ["--from", ${JSON.stringify(ORCH)}, "--to", "human", "--question", "nonterminal executor post-handoff write", "--resolved", "no"]);`);
  t.after(() => runner.release());
  await runner.started;
  runner.release();
  const result = await runner.closed;
  assert.notEqual(result.status, 0, "the nonterminal executor's later governed write is refused");
  assert.match(result.stderr, /integration authority changed|stale integration executor|integration authority/);
  const record = f.record();
  assert.equal(record.holder.handle, WORKER);
  assert.equal(record.operation, null);
  assert.doesNotMatch(fs.readFileSync(path.join(f.coord, "QUESTIONS.md"), "utf8"), /nonterminal executor post-handoff write/);
});

test("COORD-915: the holder keeps authority across a released and rebound session", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  const first = f.record().holder.session_id;
  f.ok("orch", ["agent-release", ORCH]);
  f.bind("orch", ORCH);
  f.publish("orch", ORCH, "holder publishes from a new session");
  const rec = f.record();
  assert.equal(rec.holder.handle, ORCH);
  assert.notEqual(rec.holder.session_id, first);
  assert.ok(rec.history.some((e) => e.event === "holder-session-refreshed" && e.session_id === rec.holder.session_id));
});

test("COORD-915: a governed write that bypasses the dispatch guard is still refused inside the mutation lock", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  f.ok("orch", ["integration", "begin", "TEST-001"]);
  f.bind("other", WORKER);
  const direct = (thread, from) => {
    const script = `
      const cli = require(${JSON.stringify(path.join(f.coord, "engine/scripts/cli.js"))});
      try { cli.__testing.dispatchCommand("log-question", ${JSON.stringify(f.question(thread, from).slice(1))}); }
      catch (error) { console.error(error.message); process.exit(3); }`;
    return spawnSync(process.execPath, ["-e", script], { cwd: f.root, env: f.env(thread), encoding: "utf8" });
  };
  const foreign = direct("other", WORKER);
  assert.equal(foreign.status, 3);
  assert.match(foreign.stderr, /Refusing "log-question": integration operation iop-/);
  const own = direct("orch", ORCH);
  assert.equal(own.status, 0, own.stderr);
});

test("COORD-915: a failing thread resolver leaves the caller unidentified rather than attributed", () => {
  const saved = authority.__testing.getSessionReaders();
  try {
    authority.__testing.setSessionReaders({ resolveEffectiveThreadId: () => { throw new Error("no runtime"); } });
    assert.equal(authority.resolveCaller(), null);
    authority.__testing.setSessionReaders(null);
    assert.equal(authority.resolveCaller(), null);
  } finally {
    authority.__testing.setSessionReaders(saved);
  }
});

test("COORD-915: handoff without an open operation, unknown subcommands and off-board tickets", (t) => {
  const f = fixture(t);
  f.refused("orch", ["integration"], /requires a subcommand/);
  f.refused("orch", ["integration", "bogus"], /requires a subcommand/);
  f.ok("orch", ["integration", "recover"]);
  f.bind("orch", ORCH);
  f.refused("orch", ["integration", "begin"], /requires <ticket-id>/);
  f.ok("orch", ["integration", "handoff", "--to", WORKER, "--human-admin-override", "assign the integrator before any work"]);
  assert.equal(f.record().holder.handle, WORKER);
  assert.equal(f.record().operation, null);
  f.refused("orch", ["integration", "handoff", "--human-admin-override", "x"], /requires --to/);
  f.bind("worker", WORKER);
  f.ok("worker", ["integration", "begin", "TEST-404"]);
  const report = JSON.parse(f.ok("worker", ["integration", "recover", "--json"]).stdout);
  assert.equal(report.verification.ticket_status, null);
  assert.equal(report.verification.ticket, "TEST-404");
});

test("COORD-915: a failing terminal verb never overwrites an operation that was replaced while it ran", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  const file = path.join(f.coord, ".runtime", authority.RECORD_FILE);
  const body = `const fs = require("node:fs"); const r = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, "utf8"));
    fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({ ...r, operation: { ...r.operation, id: "iop-replaced" } }));
    throw new Error("finalize failed");`;
  const r = runGuarded(f, "orch", "finalize", body);
  assert.equal(r.status, 3);
  assert.equal(f.record().operation.id, "iop-replaced");
  assert.equal(f.record().operation.status, "open");
});

function journalEvents(f) {
  const file = path.join(f.coord, ".runtime", "governance-events.ndjson");
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

function authorityEvents(f, command) {
  return journalEvents(f).filter((e) => e.command === command);
}

test("COORD-915: an implicit first grant is journaled as implicit-first-integration-verb and shown by status", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.publish("orch", ORCH, "first publish");
  const grants = authorityEvents(f, "integration-grant");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].details.granted_via, "implicit-first-integration-verb");
  assert.equal(grants[0].details.handle, ORCH);
  assert.equal(grants[0].details.session_id, f.record().holder.session_id);
  assert.equal(grants[0].details.command, "sync");
  assert.match(grants[0].details.txn, /^itx-/);
  assert.equal(f.record().pending, undefined, "the pair committed");
  const status = JSON.parse(f.ok("orch", ["integration", "status", "--json"]).stdout);
  assert.deepEqual(status.grant_event, { ts: grants[0].ts, command: "integration-grant", granted_via: "implicit-first-integration-verb", session_id: grants[0].details.session_id });
  assert.match(f.ok("orch", ["integration", "status"]).stdout, /grant event: integration-grant at .* \(granted_via implicit-first-integration-verb\)/);
});

test("COORD-915: handoff, operation and recovery events are journaled with both handles and sessions", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  f.ok("orch", ["integration", "begin", "TEST-001"]);
  f.bind("next", WORKER);
  f.ok("next", ["integration", "handoff", "--to", WORKER, "--human-admin-override", "orchestrator unavailable"]);
  const [handoff] = authorityEvents(f, "integration-handoff");
  assert.equal(handoff.details.from, ORCH);
  assert.equal(handoff.details.to, WORKER);
  assert.ok(handoff.details.from_session_id);
  assert.ok(handoff.details.to_session_id);
  assert.equal(handoff.details.granted_via, "handoff");
  assert.equal(handoff.details.operation, f.record().operation.id);
  f.ok("next", ["integration", "recover", "--resume"]);
  const [recover] = authorityEvents(f, "integration-recover");
  assert.equal(recover.details.action, "resume");
  assert.equal(recover.details.handle, WORKER);
  assert.equal(recover.details.verification.ticket, "TEST-001");
  const status = JSON.parse(f.ok("next", ["integration", "status", "--json"]).stdout);
  assert.equal(status.grant_event.command, "integration-handoff");
  // A refused terminal verb journals nothing (COORD-843/855 byte-identity); the release is journaled.
  f.ok("next", ["integration", "recover", "--abandon", "--human-admin-override", "verified"]);
  const journal = path.join(f.coord, ".runtime", "governance-events.ndjson");
  const before = fs.readFileSync(journal);
  assert.notEqual(f.run("next", ["finalize", "TEST-001"]).status, 0);
  assert.ok(fs.readFileSync(journal).equals(before), "a refused finalize leaves the journal byte-identical");
  f.ok("next", ["integration", "release"]);
  assert.equal(authorityEvents(f, "integration-release")[0].details.handle, WORKER);
});

// COORD-1005: every kill window in this file is a real child process that a test crashes with a
// process-group SIGKILL (crashChild). The child reaches its fault point; holdStatement() publishes
// the point it reached and blocks; the parent then kills the whole group, so no grandchild survives.
function reachedFile(f) { return path.join(f.root, "reached.json"); }
function holdStatement(f, point, extra = "{}") {
  return `require(${JSON.stringify(HOLD_HELPER)}).holdAt(${JSON.stringify(reachedFile(f))}, Object.assign({ point: ${JSON.stringify(point)} }, ${extra}));`;
}
function crashChild(f, thread, script, beforeKill = null) {
  return crashAtHold(["-e", script], { cwd: f.root, env: f.env(thread), reachedPath: reachedFile(f), beforeKill });
}
function assertCrashed(crash, point) {
  assert.ok(crash.reached, `the child must reach fault point ${point}: ${crash.stderr}`);
  assert.equal(crash.reached.point, point, "the child must stop at the named fault point");
  assert.equal(crash.signal, "SIGKILL", `the child must be killed at ${point}: ${crash.stderr}`);
}
function runGuardedCrash(f, thread, verb, point) {
  return crashChild(f, thread, `
    const ia = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-authority.js"))});
    require(${JSON.stringify(path.join(f.coord, "engine/scripts/cli.js"))});
    ia.guardCommand(${JSON.stringify(verb)}, ["TEST-001"], () => { ${holdStatement(f, point)} });`);
}
function faultRun(f, thread, point) {
  const script = `
    const ia = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-authority.js"))});
    require(${JSON.stringify(path.join(f.coord, "engine/scripts/cli.js"))});
    const { execFileSync } = require("node:child_process");
    ia.__testing.setFaultHook((at) => { if (at === ${JSON.stringify(point)}) { ${holdStatement(f, point)} } });
    // The verb changes canonical state, so its grant is journaled after it.
    const run = () => execFileSync("git", ["-C", ${JSON.stringify(f.coord)}, "commit", "--allow-empty", "-m", "published"]);
    try { ia.guardCommand("sync", ["--commit", "x"], run); }
    catch (error) { console.error(error.message); process.exit(3); }`;
  return crashChild(f, thread, script);
}

test("COORD-915: a crash after the record write and before the journal append grants nothing, and a retry converges", async (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  const crash = await faultRun(f, "orch", "record-written");
  assertCrashed(crash, "record-written");
  assert.equal(f.record().pending.event, "granted", "the crash left an uncommitted pair on disk");
  assert.equal(authorityEvents(f, "integration-grant").length, 0);
  const status = JSON.parse(f.ok("orch", ["integration", "status", "--json"]).stdout);
  assert.equal(status.holder, null, "no usable authority without its journal event");
  // The rollback restores the prior record: absent here, because sync grants before it runs.
  assert.equal(f.record(), null, "the uncommitted pair was rolled back");
  f.publish("orch", ORCH, "retry");
  assert.equal(authorityEvents(f, "integration-grant").length, 1);
  assert.equal(f.record().holder.handle, ORCH);
  assert.equal(f.record().pending, undefined);
});

test("COORD-915: a crash after the journal append completes the pair on the next read", async (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  const crash = await faultRun(f, "orch", "journal-appended");
  assertCrashed(crash, "journal-appended");
  assert.ok(f.record().pending, "the record still carries the pending mark");
  assert.equal(authorityEvents(f, "integration-grant").length, 1);
  f.publish("orch", ORCH, "retry");
  assert.equal(f.record().holder.handle, ORCH);
  assert.equal(f.record().pending, undefined);
  assert.equal(authorityEvents(f, "integration-grant").length, 1, "the retry does not grant twice");
});

test("COORD-1005: a group kill of a crashed integration-authority child leaves no orphaned grandchild", async (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  const beforeKill = (reached) => {
    assert.ok(Number.isInteger(reached.grandchild) && isAlive(reached.grandchild), "the grandchild must be running when the group is killed");
  };
  const crash = await crashChild(f, "orch", `
    const { spawn } = require("node:child_process");
    const ia = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-authority.js"))});
    require(${JSON.stringify(path.join(f.coord, "engine/scripts/cli.js"))});
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    ia.guardCommand("finalize", ["TEST-001"], () => { ${holdStatement(f, "orphan-probe", "{ grandchild: grandchild.pid }")} });`, beforeKill);
  assertCrashed(crash, "orphan-probe");
  const { pid, grandchild } = crash.reached;
  try {
    assert.ok(await waitUntil(() => !isAlive(grandchild), 3000), "the group kill must reach the grandchild, not orphan it");
    assert.equal(isAlive(pid), false, "the killed child must be gone");
  } finally {
    try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("COORD-915 journal transaction: a durable event stays paired when checkpoint writing fails", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  const script = `
    const path = require("node:path");
    const stateIo = require(${JSON.stringify(path.join(f.coord, "engine/scripts/state-io.js"))});
    const writeAtomic = stateIo.writeFileAtomicSync;
    const checkpoint = ${JSON.stringify(path.join(f.coord, ".runtime/governance-latest-snapshot.json"))};
    stateIo.writeFileAtomicSync = (file, ...args) => {
      if (path.resolve(file) === checkpoint) throw new Error("injected checkpoint write failure");
      return writeAtomic(file, ...args);
    };
    require(${JSON.stringify(path.join(f.coord, "engine/scripts/cli.js"))});
    const commands = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-commands.js"))}).createIntegrationCommands();
    try { commands.integrationCommand(["claim"]); }
    catch (error) { console.error(error.message); process.exit(3); }`;
  const failed = spawnSync(process.execPath, ["-e", script], { cwd: f.root, env: f.env("orch"), encoding: "utf8" });
  assert.equal(failed.status, 3, failed.stderr);
  assert.match(failed.stderr, /injected checkpoint write failure/);

  const events = fs.readFileSync(path.join(f.coord, ".runtime/governance-events.ndjson"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const claim = events.find((event) => event.command === "integration-claim");
  assert.ok(claim && claim.details?.txn, "the journal event was durably appended before checkpoint failure");
  assert.equal(f.record()?.holder?.handle, ORCH, "the record follows its already-appended claim event");
  assert.equal(f.record()?.pending, undefined, "the durable transaction is settled rather than rolled back");
});

test("COORD-915 journal transaction: a torn trailing JSON fragment cannot commit a pending record", async (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  const crashScript = `
    const fs = require("node:fs");
    const ia = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-authority.js"))});
    require(${JSON.stringify(path.join(f.coord, "engine/scripts/cli.js"))});
    const { createIntegrationCommands } = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-commands.js"))});
    ia.__testing.setFaultHook((point) => {
      if (point !== "record-written") return;
      const record = JSON.parse(fs.readFileSync(ia.recordPath(), "utf8"));
      fs.appendFileSync(${JSON.stringify(path.join(f.coord, ".runtime/governance-events.ndjson"))},
        '{"command":"integration-claim","details":{"txn":"' + record.pending.txn + '"');
      ${holdStatement(f, "record-written")}
    });
    createIntegrationCommands().integrationCommand(["claim"]);`;
  const crashed = await crashChild(f, "orch", crashScript);
  assertCrashed(crashed, "record-written");
  const pending = f.record();
  assert.ok(pending?.pending?.txn);
  const journal = fs.readFileSync(path.join(f.coord, ".runtime/governance-events.ndjson"), "utf8");
  assert.ok(journal.endsWith(`"txn":"${pending.pending.txn}"`), "the torn suffix contains only the transaction id prefix");

  const settleScript = `
    require(${JSON.stringify(path.join(f.coord, "engine/scripts/cli.js"))});
    const ia = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-authority.js"))});
    ia.readRecord();`;
  const settled = spawnSync(process.execPath, ["-e", settleScript], { cwd: f.root, env: f.env("orch"), encoding: "utf8" });
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal(f.record(), null, "a malformed trailing fragment is not a committed event");

  f.ok("orch", ["integration", "claim"]);
  const repairedEvents = fs.readFileSync(path.join(f.coord, ".runtime/governance-events.ndjson"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(repairedEvents.filter((event) => event.command === "integration-claim").length, 1,
    "tail repair discards the fragment and the retry writes one complete claim event");
  assert.equal(f.record()?.holder?.handle, ORCH);
  assert.equal(f.record()?.pending, undefined);
});

test("COORD-915: a failure between the record write and the journal append rolls the record back in-process", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  const before = JSON.stringify(f.record().holder);
  const r = (() => {
    const script = `
      const ia = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-authority.js"))});
      require(${JSON.stringify(path.join(f.coord, "engine/scripts/cli.js"))});
      const cmds = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-commands.js"))}).createIntegrationCommands();
      ia.__testing.setFaultHook((at) => { if (at === "record-written") throw new Error("disk full"); });
      try { cmds.integrationCommand(["release"]); } catch (error) { console.error(error.message); process.exit(3); }`;
    return spawnSync(process.execPath, ["-e", script], { cwd: f.root, env: f.env("orch"), encoding: "utf8" });
  })();
  assert.equal(r.status, 3);
  assert.match(r.stderr, /disk full/);
  assert.equal(JSON.stringify(f.record().holder), before, "the release did not take effect without its event");
  assert.equal(f.record().pending, undefined);
  assert.equal(authorityEvents(f, "integration-release").length, 0);
});

function spawnAsync(f, thread, args) {
  return new Promise((resolve) => {
    const child = require("node:child_process").spawn(process.execPath, [path.join(f.coord, "scripts/governance.js"), ...args], { cwd: f.root, env: f.env(thread) });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ thread, status, stderr }));
  });
}

for (const [label, args] of [["claim", ["integration", "claim"]], ["integration verb", ["sync", "--commit", "race"]]]) {
  test(`COORD-915: two sessions racing the first ${label} in an empty domain produce exactly one holder and one grant`, async (t) => {
    const f = fixture(t);
    f.bind("a", ORCH);
    f.bind("b", WORKER);
    f.ok("a", f.question("a", ORCH)); // pending canonical state for the winning sync to publish
    const results = await Promise.all([spawnAsync(f, "a", args), spawnAsync(f, "b", args)]);
    const winners = results.filter((r) => r.status === 0);
    assert.equal(winners.length, 1, results.map((r) => `${r.thread}:${r.status} ${r.stderr}`).join("\n"));
    const holder = f.record().holder.handle;
    assert.equal(holder, winners[0].thread === "a" ? ORCH : WORKER);
    const loser = results.find((r) => r.status !== 0);
    assert.match(loser.stderr, new RegExp(`held by ${holder}`));
    const grants = journalEvents(f).filter((e) => ["integration-grant", "integration-claim"].includes(e.command));
    assert.equal(grants.length, 1);
    assert.equal(grants[0].details.handle, holder);
  });
}

test("COORD-915: a terminal verb journals its implicit grant and close only when it changes canonical state", (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  const journal = path.join(f.coord, ".runtime", "governance-events.ndjson");
  const before = fs.readFileSync(journal);
  // Refused before any side effect, in an empty domain: no grant, no record, no journal bytes.
  assert.notEqual(f.run("orch", ["finalize", "TEST-001"]).status, 0);
  assert.equal(f.record(), null);
  assert.ok(fs.readFileSync(journal).equals(before));
  // A landing that commits canonical state journals the grant, then the close.
  const body = `execFileSync("git", ["-C", ${JSON.stringify(f.coord)}, "commit", "--allow-empty", "-m", "landing"]); return "landed";`;
  const r = runGuarded(f, "orch", "land", body);
  assert.equal(r.status, 0, r.stderr);
  const commands = journalEvents(f).map((e) => e.command).filter((c) => c.startsWith("integration-"));
  assert.deepEqual(commands, ["integration-grant", "integration-operation-close"]);
  const [grant] = authorityEvents(f, "integration-grant");
  assert.equal(grant.details.granted_via, "implicit-first-integration-verb");
  assert.equal(grant.details.command, "land");
  assert.equal(f.record().holder.provisional, undefined);
  assert.equal(f.record().operation, null);
});

test("COORD-915: a crash under a provisional first grant confers no authority but preserves the operation", async (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  const r = await runGuardedCrash(f, "orch", "finalize", "provisional-grant");
  assertCrashed(r, "provisional-grant");
  const raw = f.record();
  assert.equal(authority.executorState(raw.holder.provisional), "gone");
  assert.equal(raw.operation.ticket, "TEST-001");
  assert.equal(authorityEvents(f, "integration-grant").length, 0);
  const status = JSON.parse(f.ok("orch", ["integration", "status", "--json"]).stdout);
  assert.equal(status.holder, null, "an unjournaled grant is not usable after its executor is gone");
  assert.equal(status.operation.ticket, "TEST-001");
  f.refused("orch", ["sync", "--commit", "x"], /has no holder[\s\S]*gov integration claim/);
  f.ok("orch", ["integration", "claim"]);
  f.refused("orch", ["sync", "--commit", "x"], /needs verified recovery[\s\S]*stale executor/);
  f.ok("orch", ["integration", "recover", "--resume"]);
  assert.equal(authorityEvents(f, "integration-claim").length, 1);
});

test("COORD-915: sync publishes its own first grant, so the journal never lags HEAD; reconcile in an empty domain grants nothing", (t) => {
  const f = fixture(t);
  // Track the journal as the installed coord/.gitignore does (COORD-827 shape).
  fs.writeFileSync(path.join(f.coord, ".gitignore"), ".runtime/*\n!.runtime/governance-events.ndjson\n");
  f.git(f.coord, "add", ".gitignore", ".runtime/governance-events.ndjson");
  f.git(f.coord, "commit", "-m", "track the governance journal");
  f.bind("orch", ORCH);
  const journal = path.join(f.coord, ".runtime", "governance-events.ndjson");
  const before = fs.readFileSync(journal);
  const r = f.run("orch", ["reconcile", "--reason", "no drift", "--human-admin-override", "fixture"]);
  assert.equal(f.record(), null, "reconcile does not make the implicit first grant");
  assert.equal(journalEvents(f).filter((e) => e.command.startsWith("integration-")).length, 0, r.stderr);
  assert.ok(fs.readFileSync(journal).length >= before.length);
  // COORD-827: the first sync --commit grants and publishes the grant event in
  // the same commit, so the journal is clean against HEAD afterwards.
  f.ok("orch", ["sync", "--commit", "first publish"]);
  assert.equal(f.record().holder.handle, ORCH);
  assert.equal(authorityEvents(f, "integration-grant").length, 1);
  assert.equal(f.git(f.coord, "status", "--porcelain", "--", ".runtime/governance-events.ndjson"), "", "the grant event is committed by the sync that made it");
  f.ok("orch", ["agent-release", ORCH]);
  f.bind("orch", ORCH);
  f.ok("orch", ["sync", "--commit", "publish after a new session"]);
  assert.equal(authorityEvents(f, "integration-holder-session-refresh").length, 1);
  assert.equal(f.git(f.coord, "status", "--porcelain", "--", ".runtime/governance-events.ndjson"), "", "the refresh event is committed by the sync too");
});


test("COORD-915: a crash inside a deferred first grant leaves an empty domain that the next publication can claim", async (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  const r = await runGuardedCrash(f, "orch", "pr-merge", "deferred-grant");
  assertCrashed(r, "deferred-grant");
  const raw = JSON.parse(fs.readFileSync(path.join(f.coord, ".runtime", authority.RECORD_FILE), "utf8"));
  assert.equal(authority.executorState(raw.holder.provisional), "gone");
  assert.equal(raw.operation, null);
  const status = JSON.parse(f.ok("orch", ["integration", "status", "--json"]).stdout);
  assert.equal(status.holder, null, "a dead provisional reservation confers nothing");
  assert.equal(status.established, false, "and reads as an empty domain");
  f.publish("orch", ORCH, "first real publication");
  assert.equal(f.record().holder.handle, ORCH);
  assert.equal(authorityEvents(f, "integration-grant").length, 1);
});

// COORD-951 (3): a live pid is not enough. The executor's recorded start time must match
// the process now holding that pid, or the executor is a reused pid and is gone.
test("COORD-951 C1: an executor whose pid is alive but whose recorded start time differs is gone, never live", () => {
  const identity = require("./directory-locks.js").readOwnerIdentity(process.pid);
  assert.match(String(identity.pid_start_time), /^\d+$/, "this host exposes a process start time");
  const host = os.hostname();
  assert.equal(authority.executorState({ pid: process.pid, host, pid_start_time: "1" }), "gone",
    "a reused pid (start time mismatch) is never live");
  assert.equal(authority.executorState({ pid: process.pid, host, pid_start_time: identity.pid_start_time }), "live",
    "the same process with the recorded start time is live");
  assert.equal(authority.executorState({ pid: process.pid, host }), "live",
    "a legacy record with no start time keeps the pid-only rule (migration-safe)");
});

test("COORD-951 C2: an operation records its executor start time when it is opened by a terminal verb", async (t) => {
  const f = fixture(t);
  f.bind("orch", ORCH);
  f.ok("orch", ["integration", "claim"]);
  const script = `
    const ia = require(${JSON.stringify(path.join(f.coord, "engine/scripts/integration-authority.js"))});
    require(${JSON.stringify(path.join(f.coord, "engine/scripts/cli.js"))});
    ia.guardCommand("finalize", ["TEST-001"], () => { ${holdStatement(f, "start-time")} });`;
  const crash = await crashChild(f, "orch", script);
  assertCrashed(crash, "start-time");
  const op = f.record().operation;
  assert.match(String(op.pid_start_time), /^\d+$/,
    "the executor's start time is recorded so a later reader can detect pid reuse");
});

// COORD-951 review (orchestrator, MED): an UNREADABLE current start time is unknown, not a
// reused pid. Only a known, differing start time may classify a live pid as gone; otherwise
// the answer stays the pid-only "live" (fail closed against takeover, never fail open).
test("COORD-951 C3: a live pid whose current start time cannot be read stays live, never gone", () => {
  const directoryLocks = require("./directory-locks.js");
  const realReadOwnerIdentity = directoryLocks.readOwnerIdentity;
  try {
    directoryLocks.readOwnerIdentity = () => ({ boot_id: "unreadable-here" });
    const op = { pid: process.pid, host: os.hostname(), pid_start_time: "123" };
    assert.equal(authority.executorState(op), "live",
      "an unreadable current start time must not be treated as a reused pid");
  } finally {
    directoryLocks.readOwnerIdentity = realReadOwnerIdentity;
  }
});

// COORD-992 (F-06): executor liveness. A reused pid is gone; with /proc unreadable the answer is
// the pid-only one (live), never a takeover.
test("COORD-992: executorState: a reused executor pid is gone, and unreadable /proc keeps the PID-only answer", () => {
  const host = os.hostname();
  assert.equal(authority.executorState({ host, pid: process.pid, pid_start_time: "1" }), "gone", "reused pid");
  const realReadFile = fs.readFileSync;
  fs.readFileSync = function patched(file, ...rest) {
    if (typeof file === "string" && file === `/proc/${process.pid}/stat`) {
      const error = new Error(`EACCES: ${file}`);
      error.code = "EACCES";
      throw error;
    }
    return realReadFile.call(fs, file, ...rest);
  };
  try {
    assert.equal(authority.executorState({ host, pid: process.pid, pid_start_time: "1" }), "live", "unknown start time: pid-only");
  } finally {
    fs.readFileSync = realReadFile;
  }
});

// COORD-1041 (b): the authority record carries a real integer epoch. A committed grant, claim or
// handoff advances it; a record written before the field existed migrates on read.
test("COORD-1041 authority epoch: a legacy holder migrates to epoch 1 and an empty domain to 0", () => {
  assert.equal(authority.migrateEpoch({ holder: { handle: ORCH } }).authority_epoch, 1, "a legacy live holder is epoch 1");
  assert.equal(authority.migrateEpoch({ holder: null }).authority_epoch, 0, "a legacy empty domain is epoch 0");
  const current = { holder: null, authority_epoch: 4 };
  assert.equal(authority.migrateEpoch(current), current, "a record that already carries an epoch is returned unchanged");
  assert.equal(authority.nextEpoch(null), 1, "the first grant in a domain is epoch 1");
  assert.equal(authority.nextEpoch({ authority_epoch: 7 }), 8, "a grant advances the epoch by one");
});

test("COORD-1041 authority epoch: a claim and a handoff each advance it, and a legacy record migrates on read", () => {
  withCanonicalAuthorityContext(({ runtime, commands, setThread }) => {
    const recordFile = path.join(runtime, authority.RECORD_FILE);
    fs.writeFileSync(recordFile, JSON.stringify({
      schema: authority.SCHEMA, domain: {}, operation: null, history: [],
      holder: { handle: ORCH, session_id: "session-old", thread_id: "thread-old", granted_at: "2026-11-01T00:00:00.000Z", granted_via: "claim", reason: null },
    }));
    assert.equal(authority.readRecord().authority_epoch, 1, "the legacy holder reads back as epoch 1");
    setThread("thread-old");
    commands.integrationCommand(["handoff", "--to", WORKER, "--human-admin-override", "epoch migration regression"]);
    const handedOff = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    assert.equal(handedOff.authority_epoch, 2, "a handoff from a migrated legacy record advances the epoch to 2");
    assert.equal(handedOff.holder.handle, WORKER);
  });
  withCanonicalAuthorityContext(({ runtime, commands, setThread }) => {
    setThread("thread-old");
    commands.integrationCommand(["claim"]);
    assert.equal(authority.readRecord().authority_epoch, 1, "the first claim in an empty domain is epoch 1");
    commands.integrationCommand(["handoff", "--to", WORKER, "--human-admin-override", "epoch advance regression"]);
    assert.equal(authority.readRecord().authority_epoch, 2, "a handoff advances the epoch");
    assert.equal(authority.readRecord().holder.handle, WORKER);
    assert.ok(fs.existsSync(path.join(runtime, authority.RECORD_FILE)));
  });
});


test("COORD-1052 NEXT: mismatched and corrupted attempt fences refuse without changing authority or canonical refs", () => {
  withCanonicalAuthorityContext(({ root, git, setThread }) => {
    const remote = path.join(root, "attempt-origin.git");
    const bare = gitFixtureSpawn(root, ["init", "--bare", "--initial-branch=main", remote]);
    assert.equal(bare.status, 0, bare.stderr);
    git("remote", "add", "origin", remote);
    const ticket = "TEST-1052";
    attemptCoordination.bootstrapCanonical(root, { remote: "origin", ticket, owner: ORCH, authorityEpoch: 7 });
    setThread("thread-old");
    const caller = authority.resolveCaller();
    const holder = authority.grantHolder(caller, "test", "fence-validation");
    authority.writeRecord({ ...authority.emptyRecord(), holder, authority_epoch: 7 }, { event: "next-fence-holder" });
    const operation = authority.newOperation("finalize", ticket, caller, "terminal-verb");
    authority.writeRecord({ ...authority.readRecord(), operation }, { event: "next-fence-opened" });
    const stored = authority.readRecord();
    const canonicalOid = attemptCoordination.readCanonical(root, { remote: "origin", ticket }).oid;
    const forged = { ...stored.operation.baseline.attempt_fence, token: `${stored.operation.baseline.attempt_fence.token}tampered` };
    assert.throws(() => authority.assertTicketFence(ticket, forged),
      /supplied attempt fence differs from the persisted integration decision/);
    assert.deepEqual(authority.readRecord(), stored, "a mismatched caller-supplied fence does not rewrite the authority record");
    assert.equal(attemptCoordination.readCanonical(root, { remote: "origin", ticket }).oid, canonicalOid,
      "a mismatched caller-supplied fence does not advance the canonical ref");

    const selectedAttemptTamper = authority.readRecord();
    selectedAttemptTamper.operation.baseline.attempt_fence = {
      ...selectedAttemptTamper.operation.baseline.attempt_fence,
      selected_attempt: "unselected-attempt",
    };
    authority.writeRecord(selectedAttemptTamper, { event: "next-fence-selected-attempt-tamper" });
    const corruptedRecord = authority.readRecord();
    assert.throws(() => authority.assertTicketFence(ticket), /selected attempt changed from unselected-attempt to none/);
    assert.deepEqual(authority.readRecord(), corruptedRecord,
      "the refused corrupted operation remains available for governed recovery");
    assert.equal(attemptCoordination.readCanonical(root, { remote: "origin", ticket }).oid, canonicalOid,
      "the refusal leaves the real canonical decision ref unchanged");

    const invalid = authority.readRecord();
    delete invalid.operation.baseline.attempt_fence.token;
    authority.writeRecord(invalid, { event: "next-fence-missing-token" });
    const invalidRecord = authority.readRecord();
    assert.throws(() => authority.assertTicketFence(ticket), /integration operation has an invalid attempt fence/);
    assert.deepEqual(authority.readRecord(), invalidRecord);
    assert.equal(attemptCoordination.readCanonical(root, { remote: "origin", ticket }).oid, canonicalOid);
  });
});

test("ticket fence verifies an epoch-zero decision before an integration operation is opened", () => {
  withCanonicalAuthorityContext(({ root, git }) => {
    const remote = path.join(root, "attempt-origin.git");
    const bare = gitFixtureSpawn(root, ["init", "--bare", "--initial-branch=main", remote]);
    assert.equal(bare.status, 0, bare.stderr);
    git("remote", "add", "origin", remote);

    const ticket = "TEST-1054";
    const original = attemptCoordination.bootstrapCanonical(root, { remote: "origin", ticket, owner: ORCH, authorityEpoch: 0 });
    assert.equal(authority.readRecord(), null);
    const snapshot = authority.decisionFenceForTicket(ticket);
    assert.equal(snapshot.authority_epoch, 0);
    assert.equal(snapshot.selected_attempt, null);
    assert.equal(authority.assertTicketFence(ticket, snapshot).reason, "current");

    const selected = "a".repeat(32);
    const transition = attemptCoordination.publishCanonicalTransition(root, {
      remote: "origin",
      ticket,
      expected: original,
      next: { ...original.record, generation: 1, selected_attempt: selected },
    });
    assert.equal(transition.status, "published");
    assert.throws(() => authority.assertTicketFence(ticket, snapshot), /canonical attempt fence is stale/);
    const fresh = authority.decisionFenceForTicket(ticket);
    assert.equal(authority.assertTicketFence(ticket).selected_attempt, selected);
    assert.throws(() => authority.assertTicketFence(ticket, { ...fresh, selected_attempt: null }),
      new RegExp(`selected attempt changed from none to ${selected}`));
    assert.equal(authority.readRecord(), null);
    assert.equal(attemptCoordination.readCanonical(root, { remote: "origin", ticket }).oid, transition.commit);
  });
});

test("COORD-1052 NEXT: a Git workspace without an attempt remote remains explicitly legacy-unfenced", () => {
  withCanonicalAuthorityContext(({ root }) => {
    const captured = authority.captureTicketFence("TEST-1053");
    assert.equal(captured.status, "legacy-absent");
    assert.equal(captured.reason, "attempt-remote-unconfigured");
    assert.doesNotThrow(() => authority.assertTicketFence("TEST-1053"));
    assert.deepEqual(authority.decisionFenceForTicket("TEST-1053"), captured);
    const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const bin = path.join(root, "quiet-git-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"),
      `#!/bin/sh\n[ "$3" = remote ] && exit 2\nexec "${git}" "$@"\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
      assert.throws(() => authority.captureTicketFence("TEST-1053"), /Could not inspect configured attempt remotes in .*: git remote failed/);
    } finally {
      process.env.PATH = oldPath;
    }
    assert.equal(authority.readRecord(), null);
  });
});

test("signed handoff and recovery revalidate the state observed by the approver", () => {
  const scenarios = [
    { action: "handoff", change: "authority", refusal: /authority changed after human approval/ },
    { action: "handoff", change: "target", refusal: /target session or caller changed after human approval/ },
    { action: "handoff", change: "caller", refusal: /target session or caller changed after human approval/ },
    { action: "recover", change: "operation", refusal: /operation changed after human approval/ },
    { action: "recover", change: "caller", refusal: /caller session changed after human approval/ },
    { action: "recover", change: "git", refusal: /executor or repository state changed after human approval/ },
  ];
  for (const { action, change, refusal } of scenarios) {
    let moveState;
    withCanonicalAuthorityContext(({ root, commands, eventLogPath, setThread, updateSession }) => {
      setThread("thread-old");
      commands.integrationCommand(["claim"]);
      if (action === "recover") commands.integrationCommand(["begin", "TEST-001"]);
      moveState = () => {
        const record = authority.readRecord();
        if (change === "authority") {
          authority.writeRecord({ ...record, authority_epoch: record.authority_epoch + 1 });
        } else if (change === "operation") {
          authority.writeRecord({ ...record, operation: { ...record.operation, requires_recovery: true } });
        } else if (change === "target") {
          updateSession("thread-new", { session_id: "replacement-target" });
        } else if (change === "caller") {
          setThread("thread-new");
        } else {
          fs.appendFileSync(path.join(root, "seed.txt"), "concurrent edit\n");
        }
      };
      const args = action === "handoff" ? ["handoff", "--to", WORKER] : ["recover", "--abandon"];
      assert.throws(() => commands.integrationCommand([...args, "--human-admin-override", "reviewed state"]), refusal);
      assert.equal(authority.readRecord().holder.handle, ORCH);
      assert.equal(Boolean(authority.readRecord().operation), action === "recover");
      const events = fs.readFileSync(eventLogPath, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(events.filter((event) => event.event === "approval.verified").length, 1);
      assert.equal(events.some((event) => event.command === `integration-${action}`), false);
    }, { onVerified: () => moveState() });
  }
});
