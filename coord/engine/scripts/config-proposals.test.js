"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createConfigProposals, createConfigProposalCommand, parseConfigProposalArgs, digest, readStaticTestPolicy, renderTestPolicy } = require("./config-proposals.js");
const governance = require("./governance.js");
const lifecycle = require("./lifecycle.js");
const governanceContext = require("./governance-context.js");
const testUtils = require("../../scripts/governance-test-utils.js");

function fixture(overrides = {}, initialSource = 'module.exports = { testPolicy: { "stageMap": { "staging": "promotion" } } };\n') {
  let source = initialSource;
  let value = readStaticTestPolicy(source);
  const events = [];
  const writes = [];
  let counter = 0;
  const api = createConfigProposals({
    readTarget: () => ({ source, value }),
    renderTarget: (_target, before, nextValue) => renderTestPolicy(before, nextValue),
    diff: (before, after) => ({ before: digest(before), after: digest(after) }),
    validateTarget: (_target, input) => input && Object.hasOwn(input, "notAllowed") ? ["testPolicy.notAllowed refused"] : [],
    writeTarget: (_target, next) => { writes.push(next); source = next; value = readStaticTestPolicy(next); },
    readEvents: () => [...events],
    appendEvent: (event) => { events.push(event); },
    withMutation: (_name, operation) => operation(),
    authorizeHumanAdmin: () => ({ ok: true, mode: "signed", session_id: "signed-session", record_id: "approval-record" }),
    now: () => "2026-11-17T00:00:00.000Z",
    newId: () => `proposal-${++counter}`,
    ...overrides,
  });
  return { api, events, writes, read: () => source, set: (value) => { source = value; } };
}

test("proposing is inert except for its journal event and returns the reusable diff", async () => {
  const f = fixture();
  const before = f.read();
  const result = await f.api.propose({ target: "project.testPolicy", proposed: { stageMap: { qa: "pr" } }, actor: { handle: "operator", session_id: "s1" } });
  assert.equal(result.proposal_id, "proposal-1");
  assert.deepEqual(result.diff, { before: digest(before), after: digest(renderTestPolicy(before, { stageMap: { qa: "pr" } })) });
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, "config.proposed");
  assert.equal(f.read(), before);
  assert.equal(f.writes.length, 0);
});

test("closed target list and schema refuse engine-owned or unknown configuration", async () => {
  const f = fixture();
  assert.throws(() => f.api.propose({ target: "guard-registry", proposed: {} }), /allowed: project\.testPolicy/);
  assert.throws(() => f.api.propose({ target: "project.testPolicy", proposed: { guardRegistry: {} } }), /engine-owned key/);
  assert.throws(() => f.api.propose({ target: "project.testPolicy", proposed: { notAllowed: true } }), /unknown or engine-owned key/);
  assert.equal(f.events.length, 3);
  assert.ok(f.events.every((event) => event.type === "config.proposal_refused"));
  assert.equal(f.writes.length, 0);
});

test("approval applies exactly the recorded result once and journals one apply", async () => {
  const f = fixture();
  const proposal = await f.api.propose({ target: "project.testPolicy", proposed: { stageMap: { qa: "pr" } }, actor: { handle: "p", session_id: "ps" } });
  const expected = renderTestPolicy(f.read(), { stageMap: { qa: "pr" } });
  const applied = await f.api.approve({ proposalId: proposal.proposal_id, reason: "approved for test", actor: { handle: "admin", session_id: "hs" } });
  assert.equal(f.read(), expected);
  assert.deepEqual(f.writes, [expected]);
  assert.equal(applied.diff.after, digest(expected));
  assert.equal(f.events.filter((event) => event.type === "config.applied").length, 1);
  assert.equal(f.events.find((event) => event.type === "config.applied").approver_session, "signed-session");
  assert.equal(f.events.find((event) => event.type === "config.applied").approver, "signed-session");
  assert.equal(f.events.find((event) => event.type === "config.applied").approval_record, "approval-record");
  assert.throws(() => f.api.approve({ proposalId: proposal.proposal_id, reason: "again", actor: { handle: "admin", session_id: "hs" } }), /already applied/);
  assert.equal(f.writes.length, 1);
});

test("approval authority receives the proposal id, closed target and exact result digests", async () => {
  let authority;
  const f = fixture({ authorizeHumanAdmin: (context) => { authority = context; return { ok: true, mode: "signed", session_id: "signed-session", record_id: "approval-record" }; } });
  const proposal = await f.api.propose({ target: "project.testPolicy", proposed: { stageMap: { qa: "pr" } } });
  await f.api.approve({ proposalId: proposal.proposal_id, reason: "approved", actor: { handle: "admin", session_id: "hs" } });
  assert.equal(authority.proposalId, proposal.proposal_id);
  assert.equal(authority.target, "project.testPolicy");
  assert.equal(authority.baseDigest, proposal.base_digest);
  assert.equal(authority.resultDigest, f.events.find((event) => event.type === "config.proposed").result_digest);
});

test("approval refuses stale base bytes before writing", async () => {
  const f = fixture();
  const proposal = await f.api.propose({ target: "project.testPolicy", proposed: { stageMap: { qa: "pr" } } });
  f.set("module.exports = { testPolicy: {} };\n");
  assert.throws(() => f.api.approve({ proposalId: proposal.proposal_id, reason: "approved", actor: { handle: "admin", session_id: "hs" } }), /stale config proposal/);
  assert.equal(f.writes.length, 0);
});

test("approval rechecks after authorization so concurrent manual edits survive untouched", async () => {
  let f;
  const external = 'module.exports = { testPolicy: { "stageMap": { "manual": "pr" } } };\n';
  f = fixture({ authorizeHumanAdmin: () => { f.set(external); return { ok: true, mode: "signed", session_id: "signed-session", record_id: "approval-record" }; } });
  const proposal = await f.api.propose({ target: "project.testPolicy", proposed: { stageMap: { qa: "pr" } } });
  assert.throws(() => f.api.approve({ proposalId: proposal.proposal_id, reason: "approved", actor: { handle: "admin", session_id: "hs" } }), /changed during approval/);
  assert.equal(f.read(), external);
  assert.equal(f.writes.length, 0);
});

test("approval restores exact source bytes when journaling the apply fails", async () => {
  const stored = [];
  const f = fixture({ readEvents: () => [...stored], appendEvent: (event) => { if (event.type === "config.applied") throw new Error("journal unavailable"); stored.push(event); } });
  const before = f.read();
  const proposal = await f.api.propose({ target: "project.testPolicy", proposed: { stageMap: { qa: "pr" } } });
  assert.throws(() => f.api.approve({ proposalId: proposal.proposal_id, reason: "approved", actor: { handle: "admin", session_id: "hs" } }), /target restored/);
  assert.equal(f.read(), before);
});

test("rollback creates a forward proposal restoring the prior value", async () => {
  const f = fixture();
  const proposal = await f.api.propose({ target: "project.testPolicy", proposed: { stageMap: { qa: "pr" } } });
  await f.api.approve({ proposalId: proposal.proposal_id, reason: "approved", actor: { handle: "admin", session_id: "hs" } });
  const rollback = await f.api.rollback({ proposalId: proposal.proposal_id, actor: { handle: "operator", session_id: "s2" } });
  assert.equal(rollback.proposal_id, "proposal-2");
  assert.equal(f.events.at(-1).type, "config.proposed");
  assert.equal(JSON.stringify(f.events.at(-1).proposed_value), JSON.stringify({ stageMap: { staging: "promotion" } }));
  assert.equal(f.read(), renderTestPolicy('module.exports = { testPolicy: { "stageMap": { "staging": "promotion" } } };\n', { stageMap: { qa: "pr" } }), "rollback proposal does not apply itself");
  assert.notEqual(f.events.at(-1).result_digest, f.events[0].result_digest);
});

test("production authorization refusal prevents writes even with a supplied reason", async () => {
  const f = fixture({ authorizeHumanAdmin: () => { throw new Error("trusted human approval verifier unavailable"); } });
  const proposal = await f.api.propose({ target: "project.testPolicy", proposed: { stageMap: { qa: "pr" } } });
  assert.throws(() => f.api.approve({ proposalId: proposal.proposal_id, reason: "looks good", actor: { handle: "agent", session_id: "agent-session" } }), /trusted human approval verifier unavailable/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.events.filter((event) => event.type === "config.apply_refused").length, 1);
});

test("transition-window reason-only authority is refused for configuration apply", async () => {
  const f = fixture({ authorizeHumanAdmin: () => ({ ok: true, mode: "transition" }) });
  const proposal = await f.api.propose({ target: "project.testPolicy", proposed: { stageMap: { qa: "pr" } } });
  assert.throws(() => f.api.approve({ proposalId: proposal.proposal_id, reason: "looks good", actor: { handle: "agent", session_id: "agent-session" } }), /signed human-admin approval/);
  assert.equal(f.writes.length, 0);
});

test("targeted project.config edit preserves unrelated source and accepts only static testPolicy literals", () => {
  const source = 'module.exports = {\n  // keep this comment\n  repos: { B: { path: "backend" } },\n};\n';
  const inserted = renderTestPolicy(source, { stageMap: { qa: "pr" } });
  assert.match(inserted, /keep this comment/);
  assert.match(inserted, /repos: \{ B: \{ path: "backend" \} \}/);
  assert.deepEqual(readStaticTestPolicy(inserted), { stageMap: { qa: "pr" } });
  const replaced = renderTestPolicy(inserted, { stageMap: { staging: "promotion" } });
  assert.deepEqual(readStaticTestPolicy(replaced), { stageMap: { staging: "promotion" } });
  assert.throws(() => readStaticTestPolicy('// module.exports = { testPolicy: {} };\nmodule.exports = { testPolicy: { ...defaults } };'), /static JSON-compatible object/);
  assert.throws(() => readStaticTestPolicy('module.exports = { "testPolicy": {}, testPolicy: {} };'), /duplicate testPolicy/);
  assert.throws(() => readStaticTestPolicy('module.exports = { [target]: {}, testPolicy: {} };'), /computed top-level keys/);
  assert.throws(() => readStaticTestPolicy('module.exports = { testPolicy: {} }; module.exports.testPolicy = dangerous;'), /executable code after/);
  assert.throws(() => readStaticTestPolicy('module.exports = { testPolicy: null };'), /explicit null testPolicy values are unsupported/);
});

test("rollback of an originally absent override proposes removal without applying it", async () => {
  const initial = 'module.exports = { repos: {} };\n';
  const f = fixture({}, initial);
  const proposal = await f.api.propose({ target: "project.testPolicy", proposed: { stageMap: { qa: "pr" } } });
  await f.api.approve({ proposalId: proposal.proposal_id, reason: "approved", actor: { handle: "admin", session_id: "hs" } });
  const rollback = await f.api.rollback({ proposalId: proposal.proposal_id, actor: { handle: "operator", session_id: "s2" } });
  assert.equal(rollback.proposal_id, "proposal-2");
  assert.equal(f.events.at(-1).proposed_value, null);
  assert.equal(readStaticTestPolicy(renderTestPolicy(f.read(), null)), null);
  assert.notEqual(f.read(), initial, "rollback is an inert forward proposal");
});

test("the production command factory journals an isolated fixture proposal and shares the UI adapter payload", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { proposalArgs } = await import("../../../frontend/apps/coord-ui/lib/config-proposals-core.js");
  const coordDir = path.resolve(__dirname, "../..");
  const rootDir = path.dirname(coordDir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-config-proposal-") );
  const configPath = path.join(tempDir, "project.config.js");
  const previousConfig = process.env.COORD_PROJECT_CONFIG;
  const previousLog = console.log;
  const events = [];
  const writes = [];
  fs.copyFileSync(path.join(coordDir, "project.config.js"), configPath);
  process.env.COORD_PROJECT_CONFIG = configPath;
  const lifecycle = { __testing: {
    withGovernanceMutation: (_meta, fn) => fn(),
    readGovernanceEventLog: () => [...events],
    appendGovernanceEvent: (event) => events.push(event),
    writeFileAtomicSync: (file, contents) => { writes.push(file); fs.writeFileSync(file, contents); },
  } };
  try {
    const command = createConfigProposalCommand({ coordDir, rootDir, lifecycle,
      ensureCurrentAgentIdentity: () => ({ agent: { handle: "fixture-operator" }, session: { session_id: "fixture-session" } }),
      fail: (message) => { throw new Error(message); },
    });
    const initial = fs.readFileSync(configPath, "utf8");
    const value = { stageMap: { qa: "pr" } };
    const args = proposalArgs({ target: "project.testPolicy", value, baseDigest: digest(initial) });
    const parsed = parseConfigProposalArgs(args.slice(2), "propose", (message) => { throw new Error(message); });
    assert.deepEqual(parsed.value, value);
    let output;
    console.log = (line) => { output = line; };
    const result = command(args.slice(1));
    assert.deepEqual(JSON.parse(output), result);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "config.proposed");
    assert.equal(events[0].proposer, "fixture-operator");
    assert.equal(events[0].proposer_session, "fixture-session");
    assert.deepEqual(result.diff, { target: "project.testPolicy", before: null, after: value });
    assert.equal(fs.readFileSync(configPath, "utf8"), initial, "proposal must leave config bytes untouched");
    assert.deepEqual(writes, [], "proposal must not write through the lifecycle writer");

    assert.throws(() => command(["propose", ...proposalArgs({ target: "project.guardRegistry", value, baseDigest: digest(initial) }).slice(2)]), /allowed: project\.testPolicy/);
    assert.equal(events.at(-1).type, "config.proposal_refused");
    assert.equal(fs.readFileSync(configPath, "utf8"), initial);
    assert.deepEqual(writes, []);
  } finally {
    console.log = previousLog;
    if (previousConfig === undefined) delete process.env.COORD_PROJECT_CONFIG;
    else process.env.COORD_PROJECT_CONFIG = previousConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gov config propose dispatches with a bound fixture identity and writes only a journal proposal", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-gov-config-proposal-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const configPath = path.join(tempDir, "project.config.js");
  const agentsPath = path.join(runtimeDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(path.join(governanceContext.COORD_DIR, "project.config.js"), configPath);
  const session = { session_id: "config-proposal-fixture-session", thread_id: "config-proposal-fixture-thread", board_path: governanceContext.state.BOARD_PATH, handle: "codexa816", status: "active", provider: "codex" };
  fs.writeFileSync(agentsPath, JSON.stringify([{ id: "fixture-agent", handle: "codexa816", status: "active", provider: "codex" }]) + "\n");
  fs.writeFileSync(sessionsPath, JSON.stringify([session]) + "\n");
  const previousMutation = lifecycle.__testing.withGovernanceMutation;
  const previousReadEvents = lifecycle.__testing.readGovernanceEventLog;
  const previousAppend = lifecycle.__testing.appendGovernanceEvent;
  const events = [];
  try {
    testUtils.withScopedGovernanceTestContext({
      RUNTIME_DIR: runtimeDir, AGENTS_PATH: agentsPath, AGENT_SESSIONS_PATH: sessionsPath,
      GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
      GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-snapshot.json"),
      GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "snapshots"),
      GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance-event.lock"),
      AGENT_STATE_LOCK_DIR: path.join(runtimeDir, "agent-state.lock"),
      COORD_STATE_LOCK_DIR: path.join(runtimeDir, "coord-state.lock"),
    }, () => {
      lifecycle.__testing.withGovernanceMutation = (_metadata, operation) => operation();
      lifecycle.__testing.readGovernanceEventLog = () => [...events];
      lifecycle.__testing.appendGovernanceEvent = (event) => { events.push(event); return event; };
      const before = fs.readFileSync(configPath, "utf8");
      const digestBefore = digest(before);
      const result = governance.executeCommand(["config", "propose", "--target", "project.testPolicy", "--base-digest", digestBefore,
        "--value-json", JSON.stringify({ stageMap: { qa: "pr" } })], {
        env: { ...process.env, COORD_PROJECT_CONFIG: configPath, COORD_PROVIDER: "codex", AGENT_THREAD_ID: session.thread_id,
          CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: undefined, AGENT_THREAD_ID_OVERRIDE: undefined },
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(fs.readFileSync(configPath, "utf8"), before, "proposal must not edit project.config.js");
      const proposal = events.find((event) => event.type === "config.proposed");
      assert.ok(proposal, "CLI route must append a config.proposed journal event");
      assert.equal(proposal.proposer, "codexa816");
      assert.equal(proposal.proposer_session, session.session_id);
      assert.deepEqual(JSON.parse(result.stdout).diff.after, { stageMap: { qa: "pr" } });
      assert.equal(events.some((event) => event.type === "config.applied"), false);
    });
  } finally {
    lifecycle.__testing.withGovernanceMutation = previousMutation;
    lifecycle.__testing.readGovernanceEventLog = previousReadEvents;
    lifecycle.__testing.appendGovernanceEvent = previousAppend;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("config approval consumes an explicit signed fixture bound to proposal id, target and digests", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const verifier = require("./approval-verifier.js");
  const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
  const fixtureApproval = createApprovalFixture({ allowedVerbs: ["config approve"] });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-config-signed-approval-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const configPath = path.join(tempDir, "project.config.js");
  const journalPath = path.join(runtimeDir, "governance-events.ndjson");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(journalPath, "");
  fs.copyFileSync(path.join(governanceContext.COORD_DIR, "project.config.js"), configPath);
  const previousConfig = process.env.COORD_PROJECT_CONFIG;
  const events = [];
  const writes = [];
  process.env.COORD_PROJECT_CONFIG = configPath;
  const lifecycleFixture = { __testing: {
    withGovernanceMutation: (_meta, fn) => fn(),
    readGovernanceEventLog: () => [...events],
    appendGovernanceEvent: (event) => { events.push(event); fs.appendFileSync(journalPath, `${JSON.stringify(event)}\n`); return event; },
    writeFileAtomicSync: (file, contents) => { writes.push(contents); fs.writeFileSync(file, contents); },
  } };
  try {
    testUtils.withScopedGovernanceTestContext({ RUNTIME_DIR: runtimeDir }, () => {
      const command = createConfigProposalCommand({ coordDir: governanceContext.COORD_DIR, rootDir: governanceContext.ROOT_DIR,
        lifecycle: lifecycleFixture,
        ensureCurrentAgentIdentity: () => ({ agent: { handle: "fixture-proposer" }, session: { session_id: "fixture-agent-session" } }),
        fail: (message) => { throw new Error(message); }, approvalClient: fixtureApproval.client(),
      });
      const proposedValue = { stageMap: { qa: "pr" } };
      const proposal = command(["propose", "--target", "project.testPolicy", "--value-json", JSON.stringify(proposedValue)]);
      const reason = "fixture signed approval for proposal test";
      const state = verifier.canonicalJson({ proposal_id: proposal.proposal_id, target: proposal.target,
        base_digest: proposal.base_digest, result_digest: events.find((event) => event.type === "config.proposed").result_digest });
      const subjectDigest = verifier.subjectSha256({ verb: "config approve", ticket: proposal.proposal_id, reason, state });
      const session = fixtureApproval.login({ verb: "config approve", ticket: proposal.proposal_id, subject_sha256: subjectDigest });
      const beforeApply = fs.readFileSync(configPath, "utf8");
      const applied = command(["approve", proposal.proposal_id, "--human-admin-override", reason]);
      assert.equal(applied.refusal, null);
      assert.equal(writes.length, 1);
      assert.notEqual(fs.readFileSync(configPath, "utf8"), beforeApply);
      const verified = events.find((event) => event.event === "approval.verified");
      const appliedEvent = events.find((event) => event.type === "config.applied");
      assert.equal(verified.ticket, proposal.proposal_id);
      assert.equal(verified.subject_sha256, subjectDigest);
      assert.equal(appliedEvent.approver_session, session.session_id);
      assert.equal(appliedEvent.approval_record, verified.approval_record);
      assert.deepEqual(readStaticTestPolicy(fs.readFileSync(configPath, "utf8")), proposedValue);
    });
  } finally {
    if (previousConfig === undefined) delete process.env.COORD_PROJECT_CONFIG;
    else process.env.COORD_PROJECT_CONFIG = previousConfig;
    fixtureApproval.cleanup();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-1052: config digests canonicalize nested objects but preserve array order", () => {
  const { canonical } = require("./config-proposals.js");
  const first = { z: [null, { b: true, a: 1 }], a: "value" };
  const reordered = { a: "value", z: [null, { a: 1, b: true }] };
  assert.equal(canonical(first), '{"a":"value","z":[null,{"a":1,"b":true}]}');
  assert.equal(digest(first), digest(reordered));
  assert.notEqual(digest(first), digest({ a: "value", z: [{ a: 1, b: true }, null] }));
});

test("COORD-1052: static config parser rejects malformed and ambiguous source without executing it", () => {
  const cases = [
    ["exports.testPolicy = {};", /expected a static/],
    ["module.exports += {};", /computed module.exports/],
    ["module.exports = build();", /object literal/],
    ["module.exports = {", /unterminated module.exports/],
    ["/* unfinished", /unterminated comment/],
    ['module.exports = { label: "unfinished };', /unterminated string/],
    ["module.exports = { 123: {} };", /unsupported top-level property/],
    ["module.exports = { testPolicy };", /direct static property/],
    ["module.exports = { repos };", /getter, shorthand or method/],
    ["module.exports = { __proto__: {} };", /__proto__/],
    [String.raw`module.exports = { 'test\Policy': {} };`, /escaped single-quoted/],
  ];
  for (const [source, expected] of cases) assert.throws(() => readStaticTestPolicy(source), expected, source);
  const source = '/* header */ module.exports = { /* before */ "testPolicy": {"stageMap":{}}, label: "a\\\"b", repos: { /* nested */ B: {} } }; // end';
  assert.deepEqual(readStaticTestPolicy(source), { stageMap: {} });
  const rewritten = renderTestPolicy(source, { execution: {} });
  assert.deepEqual(readStaticTestPolicy(rewritten), { execution: {} });
  assert.ok(rewritten.includes('label: "a\\\"b"'));
  assert.ok(rewritten.includes("/* nested */"));
});

test("COORD-1052: override removal preserves other properties in every comma position", () => {
  const sources = [
    ['module.exports = { testPolicy: {} };', 'module.exports = { };'],
    ['module.exports = { repos: {}, testPolicy: {} };', 'module.exports = { repos: {}};'],
    ['module.exports = { testPolicy: {}, repos: {} };', 'module.exports = {  repos: {} };'],
  ];
  for (const [source, expected] of sources) {
    assert.equal(renderTestPolicy(source, null), expected);
    assert.equal(readStaticTestPolicy(expected), null);
  }
  const absent = "module.exports = { repos: {} };";
  assert.equal(renderTestPolicy(absent, null), absent);
});

test("COORD-1052: proposal validation and approval integrity refusals leave source unchanged", () => {
  const f = fixture();
  const before = f.read();
  for (const proposed of [false, [], "text"]) {
    assert.throws(() => f.api.propose({ target: "project.testPolicy", proposed }), /JSON object/);
  }
  assert.throws(() => f.api.propose({ target: "project.testPolicy", proposed: {}, baseDigest: "stale" }), /stale config proposal/);
  assert.throws(() => f.api.approve({ proposalId: "missing", reason: "approved" }), /unknown config proposal/);
  assert.throws(() => f.api.approve({ proposalId: "missing", reason: " " }), /reason/);
  assert.throws(() => f.api.rollback({ proposalId: "missing" }), /requires an applied proposal/);
  const p = f.api.propose({ target: "project.testPolicy", proposed: {} });
  f.events.find((event) => event.type === "config.proposed").result_digest = "altered";
  assert.throws(() => f.api.approve({ proposalId: p.proposal_id, reason: "approved" }), /result digest mismatch/);
  assert.equal(f.read(), before);
  assert.deepEqual(f.writes, []);
  let errors = ["invalid stage mapping"];
  const checked = fixture({ validateTarget: () => errors });
  assert.throws(() => checked.api.propose({ target: "project.testPolicy", proposed: {} }), /invalid stage mapping/);
  errors = [];
  const valid = checked.api.propose({ target: "project.testPolicy", proposed: {} });
  errors = ["policy changed"];
  assert.throws(() => checked.api.approve({ proposalId: valid.proposal_id, reason: "approved" }), /refused at apply: policy changed/);
  assert.deepEqual(checked.writes, []);
});

test("COORD-1052: config argument parsing validates JSON files and rejects ambiguous options", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-config-args-"));
  const file = path.join(dir, "proposal.json");
  const fail = (message) => { throw new Error(message); };
  try {
    fs.writeFileSync(file, '{"stageMap":{"qa":"pr"}}');
    assert.deepEqual(parseConfigProposalArgs(["--diff-file", file], "propose", fail), { value: { stageMap: { qa: "pr" } } });
    assert.deepEqual(parseConfigProposalArgs(["proposal-1", "--human-admin-override", "reviewed"], "approve", fail), { proposalId: "proposal-1", reason: "reviewed" });
    const cases = [
      [["--unknown", "x"], "propose", /unsupported option/],
      [["--target", "one", "--target", "two"], "propose", /repeated option/],
      [["--target"], "propose", /requires a value/],
      [["--target", "--value-json", "{}"], "propose", /requires a value/],
      [["--value-json", "{"], "propose", /valid JSON/],
      [["--diff-file", file, "--value-json", "{}"], "propose", /only one/],
      [[], "propose", /requires --diff-file/],
      [[], "approve", /requires a proposal id/],
    ];
    for (const [args, command, expected] of cases) assert.throws(() => parseConfigProposalArgs(args, command, fail), expected);
    fs.writeFileSync(file, "invalid");
    assert.throws(() => parseConfigProposalArgs(["--diff-file", file], "propose", fail), /must contain valid JSON/);
    fs.unlinkSync(file);
    assert.throws(() => parseConfigProposalArgs(["--diff-file", file], "propose", fail), /must contain valid JSON/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("COORD-1052: a missing fixture signer refuses production config approval without changing target bytes", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
  const approval = createApprovalFixture({ allowedVerbs: ["config approve"] });
  t.after(() => approval.cleanup());
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-config-no-session-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const runtimeDir = path.join(tempDir, ".runtime");
  const configPath = path.join(tempDir, "project.config.js");
  const journalPath = path.join(runtimeDir, "governance-events.ndjson");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(journalPath, "");
  fs.copyFileSync(path.join(governanceContext.COORD_DIR, "project.config.js"), configPath);
  const previousConfig = process.env.COORD_PROJECT_CONFIG;
  const previousLog = console.log;
  const events = [];
  const writes = [];
  process.env.COORD_PROJECT_CONFIG = configPath;
  const lifecycleFixture = { __testing: {
    withGovernanceMutation: (_metadata, operation) => operation(),
    readGovernanceEventLog: () => [...events],
    appendGovernanceEvent: (event) => { events.push(event); fs.appendFileSync(journalPath, `${JSON.stringify(event)}\n`); return event; },
    writeFileAtomicSync: (file, contents) => { writes.push(file); fs.writeFileSync(file, contents); },
  } };
  try {
    testUtils.withScopedGovernanceTestContext({ RUNTIME_DIR: runtimeDir }, () => {
      const command = createConfigProposalCommand({
        coordDir: governanceContext.COORD_DIR,
        rootDir: governanceContext.ROOT_DIR,
        lifecycle: lifecycleFixture,
        ensureCurrentAgentIdentity: () => ({ agent: { handle: "fixture-operator" }, session: { session_id: "fixture-session" } }),
        fail: (message) => { throw new Error(message); },
        approvalClient: approval.client(),
      });
      const proposal = command(["propose", "--target", "project.testPolicy", "--value-json", JSON.stringify({ stageMap: { qa: "pr" } })]);
      const before = fs.readFileSync(configPath, "utf8");
      assert.throws(
        () => command(["approve", proposal.proposal_id, "--human-admin-override", "reviewed but not signed"]),
        /approval|signed|session|verifier/i,
      );
      assert.equal(fs.readFileSync(configPath, "utf8"), before, "unsigned approval preserves exact target bytes");
      assert.deepEqual(writes, [], "unsigned approval never reaches the target writer");
      assert.equal(events.some((event) => event.type === "config.apply_refused"), true);
      assert.equal(events.some((event) => event.event === "approval.refused"), true);
      assert.equal(events.some((event) => event.event === "approval.verified"), false);
    });
  } finally {
    console.log = previousLog;
    if (previousConfig === undefined) delete process.env.COORD_PROJECT_CONFIG;
    else process.env.COORD_PROJECT_CONFIG = previousConfig;
  }
});

test("COORD-1052: config command rejects incomplete wiring before resolving workspace state", () => {
  const complete = {
    coordDir: governanceContext.COORD_DIR, rootDir: governanceContext.ROOT_DIR,
    lifecycle: {}, ensureCurrentAgentIdentity: () => assert.fail("must not read identity"),
    fail: (message) => { throw new Error(message); },
  };
  for (const key of Object.keys(complete)) {
    assert.throws(() => createConfigProposalCommand({ ...complete, [key]: undefined }),
      /requires resolved workspace paths, lifecycle services and fail/, key);
  }
});

test("COORD-1052: production config command refuses unevaluable config and unknown verbs without target writes", (t) => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-config-validation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "project.config.js");
  const previous = process.env.COORD_PROJECT_CONFIG;
  t.after(() => {
    if (previous === undefined) delete process.env.COORD_PROJECT_CONFIG;
    else process.env.COORD_PROJECT_CONFIG = previous;
    delete require.cache[configPath];
  });
  process.env.COORD_PROJECT_CONFIG = configPath;
  const events = [];
  const command = createConfigProposalCommand({
    coordDir: governanceContext.COORD_DIR, rootDir: governanceContext.ROOT_DIR,
    lifecycle: { __testing: {
      withGovernanceMutation: (_metadata, operation) => operation(),
      readGovernanceEventLog: () => [...events],
      appendGovernanceEvent: (event) => events.push(event),
      writeFileAtomicSync: () => assert.fail("refused or pending proposals cannot write the target"),
    } },
    ensureCurrentAgentIdentity: () => ({ agent: { handle: "fixture-operator" }, session: { session_id: "fixture-session" } }),
    fail: (message) => { throw new Error(message); },
  });
  const broken = 'module.exports = { repos: missingFixtureRepos };\n';
  fs.writeFileSync(configPath, broken);
  assert.throws(() => command(["propose", "--value-json", "{}"]), /project.config.js could not be validated:.*missingFixtureRepos/);
  assert.equal(fs.readFileSync(configPath, "utf8"), broken);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "config.proposal_refused");
  assert.throws(() => command(["remove"]), /config requires one of: propose or approve/);
  assert.equal(events.length, 1, "unknown commands must not enter a governance mutation");
  for (const source of [
    'module.exports = { repos: {},, testPolicy: {} };\n',
    'module.exports = { repos: {}], testPolicy: {} };\n',
  ]) {
    fs.writeFileSync(configPath, source);
    assert.throws(() => command(["propose", "--value-json", "{}"]), /could not be validated|unsupported top-level property syntax/);
    assert.equal(events.at(-1).type, "config.proposal_refused");
    assert.equal(fs.readFileSync(configPath, "utf8"), source);
  }
  // A minimal valid adopter config has no repo map; this is a supported default.
  const minimal = 'module.exports = {};\n';
  fs.writeFileSync(configPath, minimal);
  t.mock.method(console, "log", () => {});
  const proposed = command(["propose", "--value-json", "{}"]);
  assert.equal(proposed.refusal, null);
  assert.deepEqual(proposed.diff, { target: "project.testPolicy", before: null, after: {} });
  assert.equal(events.at(-1).type, "config.proposed");
  assert.equal(fs.readFileSync(configPath, "utf8"), minimal);

  const moduleLoader = require("node:module");
  const load = moduleLoader._load;
  const approval = ["approve", proposed.proposal_id, "--human-admin-override", "reviewed"];
  for (const [resolveVerifier, refusal] of [
    [() => { throw new Error("fixture verifier module unavailable"); }, /trusted COORD-1034 approval verifier is not installed/],
    [() => ({}), /trusted COORD-1034 approval verifier is not installed/],
    [(verifier) => ({ ...verifier, requireHumanAdminApproval: () => ({ ok: false, refused: "store-unavailable" }) }),
      /requires a signed human-admin approval/],
  ]) {
    const trustedVerifier = require("./approval-verifier.js");
    const stub = t.mock.method(moduleLoader, "_load", (request, parent, ...rest) =>
      request === "./approval-verifier.js" && parent?.filename === require.resolve("./config-proposals.js")
        ? resolveVerifier(trustedVerifier) : load(request, parent, ...rest));
    try {
      assert.throws(() => command(approval), refusal);
      assert.equal(events.at(-1).type, "config.apply_refused");
      assert.equal(fs.readFileSync(configPath, "utf8"), minimal);
    } finally {
      stub.mock.restore();
    }
  }
});

test("static config accepts a single-quoted testPolicy key and preserves neighboring values", () => {
  const source = "module.exports = { 'testPolicy': {}, other: [1, 2] };\n";
  assert.deepEqual(readStaticTestPolicy(source), {});
  const rendered = renderTestPolicy(source, { stageMap: { qa: "pr" } });
  assert.deepEqual(readStaticTestPolicy(rendered), { stageMap: { qa: "pr" } });
  assert.match(rendered, /other: \[1, 2\]/);
});

test("proposal service validates required dependencies", () => {
  assert.throws(() => createConfigProposals(), /deps\.readTarget must be a function/);
  assert.throws(() => createConfigProposals({ readTarget() {} }), /deps\.renderTarget must be a function/);
});

test("config proposal refusals preserve a non-Error dependency failure and a missing request id", () => {
  const f = fixture({ readTarget: () => { throw "target service unavailable"; } });
  const source = f.read();
  assert.throws(() => f.api.propose({ target: "project.testPolicy", proposed: {} }), /target service unavailable/);
  assert.equal(f.events.at(-1).type, "config.proposal_refused");
  assert.equal(f.events.at(-1).refusal, "target service unavailable");
  assert.throws(() => f.api.approve({ reason: "request without proposal", actor: {} }), /unknown config proposal/);
  assert.equal(f.events.at(-1).type, "config.apply_refused");
  assert.equal(f.events.at(-1).proposal_id, null);
  assert.equal(f.read(), source);
  assert.deepEqual(f.writes, []);

  const g = fixture({ authorizeHumanAdmin: () => { throw "approval service unavailable"; } });
  const before = g.read();
  const proposal = g.api.propose({ target: "project.testPolicy", proposed: {} });
  assert.throws(() => g.api.approve({ proposalId: proposal.proposal_id, reason: "reviewed" }), /approval service unavailable/);
  assert.equal(g.events.at(-1).type, "config.apply_refused");
  assert.equal(g.events.at(-1).refusal, "approval service unavailable");
  assert.equal(g.read(), before);
  assert.deepEqual(g.writes, []);
});
