"use strict";

const path = require("node:path");
const coordDir = path.resolve(__dirname, "../..");
const { resolveEngineModule } = require("../../paths.js");
const { state: governanceState, DEFAULT_PATHS: governanceDefaultPaths } = require(resolveEngineModule(coordDir, "scripts/governance-context.js"));
const utils = require("../../scripts/governance-test-utils.js");
utils.sandboxProcessRuntime();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { executeCommand, withRegisterPromptHarness, __testing } = utils;
const { buildVerbHelpText } = require("./cli.js").__testing;
const identityV2 = require("./identity-v2.js");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");

function filesBelow(root) {
  const out = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) out[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  }
  visit(root);
  return out;
}

function runSignedApproval(run, args, verb, ticket) {
  const fixture = createApprovalFixture({ allowedVerbs: [verb] });
  try {
    return withApprovalTestClient(coordDir, fixture.client(), () => {
      const first = run(args);
      const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(first.error || ""));
      assert.equal(first.ok, false, "bare override text must not authorize the mutation");
      assert.ok(digest, first.error);
      fixture.login({ verb, ticket, subject_sha256: digest[1] });
      return run(args);
    });
  } finally { fixture.cleanup(); }
}

function fixture(body) {
  return withRegisterPromptHarness("c799-amend-", { ticketId: "IMP-799" }, context => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/_(?:SESSION|THREAD|INSTANCE)_ID$/.test(key)) delete env[key];
    }
    Object.assign(env, { COORD_SESSION_ID: "c799-thread", CLAUDE_CODE_SESSION_ID: "c799-thread" });
    const run = args => executeCommand(args, {
      env,
    });
    const bind = run(["agentid", "--owner", "claudea11"]);
    assert.equal(bind.ok, true, bind.error);
    body({ ...context, run, env });
  });
}

test("amend-ticket public help states the bounded correction and authority contract", () => {
  const help = buildVerbHelpText("amend-ticket");
  for (const expected of ["--description", "--pri", "--reason", "--human-admin-override", "4 MiB"]) {
    assert.ok(help.includes(expected), expected);
  }
});

test("public amendment preserves literal prose, unrelated fields and identity; no-op and A-B-A are distinct", () => {
  fixture(({ run, readBoard, tempDir, promptOnDisk }) => {
    const original = readBoard().sections[0].rows[0];
    const prompt = fs.readFileSync(promptOnDisk);
    const identityPaths = [governanceState.AGENTS_PATH, governanceState.AGENT_SESSIONS_PATH];
    const identity = identityPaths.map(file => fs.readFileSync(file));
    const prose = "Literal $(date), `whoami`, $HOME, 'single' and \"double\"\nSecond line\n";
    const update = run(["amend-ticket", "IMP-799", "--description", prose, "--pri", "p1", "--reason", "Restore quoted source evidence"]);
    assert.equal(update.ok, true, update.error);
    const amended = readBoard().sections[0].rows[0];
    assert.deepEqual(amended, { ...original, Description: prose, Pri: "P1" });
    assert.deepEqual(fs.readFileSync(promptOnDisk), prompt);
    assert.deepEqual(identityPaths.map(file => fs.readFileSync(file)), identity);
    const events = __testing.readGovernanceEventLog().filter(event => event.command === "amend-ticket");
    assert.equal(events.length, 1);
    assert.equal(events[0].identity.owner, "claudea11");
    assert.deepEqual(events[0].details.before, { Description: original.Description, Pri: original.Pri });
    assert.deepEqual(events[0].details.after, { Description: prose, Pri: "P1" });
    assert.deepEqual(events[0].details.changed_fields, ["Description", "Pri"]);
    const beforeNoop = filesBelow(tempDir);
    const noop = run(["amend-ticket", "IMP-799", "--description", prose, "--pri", "P1", "--reason", "Already corrected"]);
    assert.equal(noop.ok, true, noop.error);
    assert.deepEqual(filesBelow(tempDir), beforeNoop);
    for (const description of [original.Description, prose]) {
      const result = run(["amend-ticket", "IMP-799", "--description", description, "--reason", "Intentional editorial revision"]);
      assert.equal(result.ok, true, result.error);
      assert.equal(readBoard().sections[0].rows[0].Description, description);
    }
    assert.equal(__testing.readGovernanceEventLog().filter(event => event.command === "amend-ticket").length, 3);
  });
});

test("public amendment rejects invalid inputs without canonical or identity effects", () => {
  fixture(({ run, tempDir }) => {
    const before = filesBelow(tempDir);
    for (const args of [
      ["amend-ticket"],
      ["amend-ticket", "IMP-799", "--reason", "no fields"],
      ["amend-ticket", "bad", "--description", "x", "--reason", "bad ID"],
      ["amend-ticket", "IMP-999", "--description", "x", "--reason", "missing ticket"],
      ["amend-ticket", "IMP-799", "--description", "x"],
      ["amend-ticket", "IMP-799", "--description", "x", "--reason", "  "],
      ["amend-ticket", "IMP-799", "--description", "  ", "--reason", "blank text"],
      ["amend-ticket", "IMP-799", "--description", "é".repeat(2 * 1024 * 1024 + 1), "--reason", "oversized UTF-8"],
      ["amend-ticket", "IMP-799", "--pri", "P99", "--reason", "bad priority"],
      ["amend-ticket", "IMP-799", "--description", "x", "--reason", "unknown field", "--owner", "claudea11"],
      ["amend-ticket", "IMP-799", "--description", "x", "--reason", "blank approval", "--human-admin-override", "  "],
    ]) {
      const result = run(args);
      assert.equal(result.ok, false, `accepted ${args.slice(0, 3).join(" ")}`);
      assert.deepEqual(filesBelow(tempDir), before, result.error);
    }
  });
});

test("priority-only amendment leaves description bytes unchanged", () => {
  fixture(({ run, readBoard }) => {
    const before = readBoard().sections[0].rows[0];
    const result = run(["amend-ticket", "IMP-799", "--pri", "P3", "--reason", "Reprioritize after reproduction"]);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(readBoard().sections[0].rows[0], { ...before, Pri: "P3" });
  });
});

function checkpointFixture() {
  __testing.appendGovernanceEvent({
    ts: new Date().toISOString(), command: "journal-baseline", ticket: null,
    before_status: null, after_status: null, identity: null,
    details: { reason: "isolated amendment authority fixture" }, changed_paths: [],
    snapshot: __testing.buildGovernanceSnapshot(),
  });
}

function activeTicket(context) {
  const { run, readBoard, boardPath, tempDir } = context;
  const seed = run(["plan", "IMP-799", "--seed"]);
  assert.equal(seed.ok, true, seed.error);
  const board = readBoard();
  Object.assign(board.sections[0].rows[0], { Owner: "claudea11", Status: "doing", Repo: "X" });
  board.waiver_index = { "IMP-799": { code: "prompt_coverage", reason: "isolated metadata fixture", recorded_by: "fixture", recorded_at: new Date().toISOString() } };
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2) + "\n");
  const session = JSON.parse(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8"))
    .find(row => row.status === "active");
  const worktree = path.join(tempDir, ".worktrees", "claudea11", "IMP-799");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(governanceState.LOCKS_DIR, "IMP-799.lock"), JSON.stringify({
    owner: "claudea11", agent_id: "a11", ticket: "IMP-799", status: "doing", repo: "coord",
    branch: "agent/claudea11-imp-799", worktree, head: "coord-no-git-head",
    started_at_utc: session.claimed_at, heartbeat_utc: new Date().toISOString(),
    session_id: session.session_id, thread_id: session.thread_id,
  }, null, 2) + "\n");
  checkpointFixture();
}

test("bound active owner can amend without changing lock, plan, status or session", () => {
  fixture(context => {
    activeTicket(context);
    const { run, readBoard } = context;
    const before = readBoard();
    const paths = [governanceState.AGENT_SESSIONS_PATH,
      path.join(governanceState.LOCKS_DIR, "IMP-799.lock"),
      path.join(governanceState.PLAN_RECORDS_DIR, "IMP-799.json")];
    const preserved = paths.map(file => fs.readFileSync(file));
    const result = run(["amend-ticket", "IMP-799", "--description", "corrected active ticket", "--reason", "Correct the reproduced scope"]);
    assert.equal(result.ok, true, result.error);
    const expected = before.sections[0].rows[0];
    assert.deepEqual(readBoard().sections[0].rows[0], { ...expected, Description: "corrected active ticket" });
    assert.deepEqual(paths.map(file => fs.readFileSync(file)), preserved);
  });
});

test("foreign active owner is refused; explicit admin approval is attributed without changing ownership", () => {
  fixture(context => {
    activeTicket(context);
    const { run, readBoard, boardPath, tempDir } = context;
    const agents = JSON.parse(fs.readFileSync(governanceState.AGENTS_PATH));
    agents.push({ id: "a12", handle: "claudea12", provider: "anthropic", status: "active", aliases: [] });
    fs.writeFileSync(governanceState.AGENTS_PATH, JSON.stringify(agents, null, 2) + "\n");
    const board = readBoard();
    board.sections[0].rows[0].Owner = "claudea12";
    fs.writeFileSync(boardPath, JSON.stringify(board, null, 2) + "\n");
    const lockPath = path.join(governanceState.LOCKS_DIR, "IMP-799.lock");
    const lock = JSON.parse(fs.readFileSync(lockPath));
    lock.owner = "claudea12";
    lock.agent_id = "a12";
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
    checkpointFixture();
    const before = filesBelow(tempDir);
    const args = ["amend-ticket", "IMP-799", "--description", "approved correction", "--reason", "Restore scope"];
    const refused = run(args);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /owned by claudea12/);
    assert.deepEqual(filesBelow(tempDir), before);
    const allowed = runSignedApproval(run, [...args, "--human-admin-override", "Fixture administrator approved this exact correction"], "amend-ticket", "IMP-799");
    assert.equal(allowed.ok, true, allowed.error);
    assert.equal(readBoard().sections[0].rows[0].Owner, "claudea12");
    assert.equal(fs.readFileSync(lockPath).toString("base64"), before[path.relative(tempDir, lockPath)]);
    const event = __testing.readGovernanceEventLog().filter(event => event.command === "amend-ticket").at(-1);
    assert.equal(event.details.human_admin_override, "Fixture administrator approved this exact correction");
    assert.ok(event.details.approval_record);
    assert.equal(event.identity.owner, "claudea11");
  });
});

for (const state of ["held", "unclaimed", "revoked", "foreign-holder", "expired"]) {
  test(`v2 ${state} actor preserves lease bytes and cannot acquire authority through amendment`, () => {
    fixture(({ run, env, tempDir }) => {
      Object.assign(env, { COORD_PROVIDER: "anthropic", COORD_INSTANCE_ID: "fixture-instance", COORD_PROVIDER_SESSION_ID: "fixture-provider-session" });
      const identity = identityV2.readEnvIdentity(env);
      let reg = identityV2.emptyRegistry();
      if (state !== "unclaimed") reg = identityV2.registerAndAcquire(reg, identity, "claudea11").registry;
      if (state === "revoked") reg.instances[0].status = "revoked";
      if (state === "expired") reg.instances[0].heartbeat_at = "2000-01-01T00:00:00.000Z";
      if (state === "foreign-holder") {
        reg.instances[0].instance_id = "other-instance";
        reg.leases.claudea11.instance_id = "other-instance";
      }
      identityV2.writeRegistry(governanceState.RUNTIME_DIR, reg);
      checkpointFixture();
      const before = filesBelow(tempDir);
      const result = run(["amend-ticket", "IMP-799", "--description", "v2 correction", "--reason", "Fixture lease check"]);
      assert.equal(result.ok, state === "held", result.error);
      const registry = identityV2.registryPath(governanceState.RUNTIME_DIR);
      assert.equal(fs.readFileSync(registry).toString("base64"), before[path.relative(tempDir, registry)]);
      if (state !== "held") assert.deepEqual(filesBelow(tempDir), before);
    });
  });
}

for (const state of ["released", "wrong-thread", "needs-normalization", "missing-sessions", "missing-registry", "disabled-agent"]) {
  test(`amendment refuses ${state} without maintaining or creating identity state`, () => {
    fixture(({ run, tempDir, env }) => {
      const sessionsPath = governanceState.AGENT_SESSIONS_PATH;
      const agentsPath = governanceState.AGENTS_PATH;
      const sessions = JSON.parse(fs.readFileSync(sessionsPath));
      if (state === "released") sessions[0].status = "released";
      if (state === "wrong-thread") env.COORD_SESSION_ID = "unbound-other-thread";
      if (state === "needs-normalization") delete sessions[0].board_path;
      fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2) + "\n");
      if (state === "missing-sessions") fs.unlinkSync(sessionsPath);
      if (state === "missing-registry") fs.unlinkSync(agentsPath);
      if (state === "disabled-agent") {
        const agents = JSON.parse(fs.readFileSync(agentsPath));
        agents[0].status = "disabled";
        fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2) + "\n");
      }
      checkpointFixture();
      const before = filesBelow(tempDir);
      const result = run(["amend-ticket", "IMP-799", "--description", "unauthorized", "--reason", "Fixture refusal"]);
      assert.equal(result.ok, false, state);
      assert.deepEqual(filesBelow(tempDir), before, result.error);
    });
  });
}

test("projection write failure rolls back the amended board and leaves no success event", () => {
  fixture(({ run, tempDir, readBoard }) => {
    const before = filesBelow(tempDir);
    const write = fs.writeFileSync;
    let injected = false;
    let sawAmendedBoard = false;
    fs.writeFileSync = function(file, ...args) {
      if (!injected && String(file) === path.join(governanceState.RENDERED_DIR, "TASKS.md")) {
        injected = true;
        sawAmendedBoard = readBoard().sections[0].rows[0].Description === "will roll back";
        throw new utils.GovernanceError("injected projection write failure");
      }
      return write.call(this, file, ...args);
    };
    try {
      const result = run(["amend-ticket", "IMP-799", "--description", "will roll back", "--reason", "Fixture rollback"]);
      assert.equal(result.ok, false);
      assert.match(result.error, /injected projection write failure/);
    } finally { fs.writeFileSync = write; }
    assert.ok(injected && sawAmendedBoard, "failure must occur after the real board write");
    assert.deepEqual(filesBelow(tempDir), before);
  });
});
