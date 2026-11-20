"use strict";
// COORD-1020 characterization, extended by COORD-1022: the in-process fixture runner must match
// the CLI spawn (`node <root>/coord/scripts/governance.js`) on identical fresh fixtures for the
// verb set that converted call sites use. Compared per step: exit status, stdout, stderr; and
// after the sequence: board, lock, journal and session-ledger bytes. Variants: the default
// fixture, the COORD-880/883 env scrub (ambient session and provider keys set on the runner
// side, scrubbed on the CLI side as the suite does), and a fixture with a custom git environment
// (the COORD-767 gitEnv shape). Isolation: back-to-back and interleaved runner calls leave the
// process env, cwd, argv, exitCode and signal/exit listeners exactly as they found them.
// Normalization is limited to per-run values (fixture root path, timestamps, git SHAs, UUIDs,
// session ids, pids, transaction ids).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule } = require("../../paths.js");
const COORD_DIR = path.resolve(__dirname, "..", "..");
const { installCanonicalEngine } = require(resolveEngineModule(COORD_DIR, "scripts/fixtures/coord-engine-schemas.js"));
const { withApprovedPacket } = require(resolveEngineModule(COORD_DIR, "scripts/fixtures/approved-reconcile.js"));
const { runFixtureGovernance, SESSION_KEYS } = require("./fixtures/fixture-governance-runner.js");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");

const TICKET = "TEST-001", OLD_OWNER = "codexa01", NEW_OWNER = "codexa02", BRANCH = "agent/codexa01-test-001-recovery";
const ROW = { ID: TICKET, Repo: "B", Type: "bug", Pri: "P1", Status: "doing (blocked: external evidence; preserve reason)", Owner: OLD_OWNER, Description: "Recovery regression", "Depends On": "" };

// Mirrors buildFixture/bindFixture in missing-ticket-lock.test.js (same fixture shape).
function buildFixture(root, gitEnv = {}) {
  const coord = path.join(root, "coord");
  const repo = path.join(root, "backend");
  const config = { repos: { B: { path: "backend", integrationBranch: "dev" } } };
  fs.mkdirSync(coord); fs.mkdirSync(repo, { recursive: true });
  for (const name of ["scripts", "engine", "board", "paths.js", "project.config.js", "GOVERNANCE.md", "AGENTS.md", "product", "prompts", "schemas", "docs", "agents.json"]) {
    if (fs.existsSync(path.join(COORD_DIR, name))) fs.cpSync(path.join(COORD_DIR, name), path.join(coord, name), { recursive: true });
  }
  installCanonicalEngine(coord, COORD_DIR);
  const write = (name, data) => { const t = path.join(coord, name); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, typeof data === "string" ? data : JSON.stringify(data)); };
  write("project.config.js", `module.exports=${JSON.stringify(config)};\n`);
  // COORD-1042: fixture git runs through test-git-fixture.js; the caller gitEnv is merged last, so the COORD-767 variant keeps its custom config.
  const git = (cwd, ...args) => { const r = gitFixtureSpawn(cwd, args, { env: gitEnv }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  gitFixture(repo, ["init", "-b", "dev"], { env: gitEnv }); git(repo, "config", "user.email", "test@example.com"); git(repo, "config", "user.name", "Test");
  git(repo, "config", "maintenance.autoDetach", "false"); git(repo, "config", "gc.autoDetach", "false");
  fs.writeFileSync(path.join(repo, "evidence.txt"), "preserve me\n"); git(repo, "add", "evidence.txt"); git(repo, "commit", "-m", "seed");
  git(repo, "worktree", "add", "-b", BRANCH, path.join(repo, ".worktrees", OLD_OWNER, TICKET));
  write("board/tasks.json", { version: 1, metadata: { title: "Recovery", last_updated: new Date().toISOString(), canonical_references: [], plan_markdown_render_statuses: ["doing", "review"], preamble: [], plan_records_required_from_ticket: { B: "TEST-999" }, landing_index_required_from_ticket: { B: "TEST-999" }, pr_index_required_from_ticket: { B: "TEST-999" } }, sections: [{ kind: "table", level: 2, heading: "Recovery", separator_before: false, columns: Object.keys(ROW), rows: [ROW] }], prompt_index: { [TICKET]: "coord/prompts/recovery.md" }, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {} });
  write("prompts/recovery.md", "# Recovery\n"); write("QUESTIONS.md", "# Questions\n"); write("PLAN.md", "");
  // COORD-1023: body for the characterized register-prompt step (cwd-relative, so both sides share it).
  write("register-body.md", "# TEST-002 register body\n\n## Acceptance Criteria\n\n- Fixture body.\n");
  write(".runtime/agents.json", [OLD_OWNER, NEW_OWNER].map((handle, i) => ({ id: `a0${i + 1}`, handle, provider: "openai", status: "active", aliases: [] })));
  write(".runtime/agent_sessions.json", []);
  write(".gitignore", ".runtime/\n");
  gitFixture(coord, ["init", "-b", "main"], { env: gitEnv }); git(coord, "config", "user.email", "test@example.com"); git(coord, "config", "user.name", "Test");
  git(coord, "config", "maintenance.autoDetach", "false"); git(coord, "config", "gc.autoDetach", "false");
  git(coord, "add", "."); git(coord, "commit", "-m", "Seed regression fixture");
  return { root, coord, repo };
}

// Environment the fixture CLI child receives (same shape as bindFixture in the suite): the
// COORD-880/883 session keys are removed, the fixture's git environment is kept.
function fixtureEnv(root, gitEnv = {}) {
  const env = { ...process.env, ...gitEnv, COORD_PROJECT_CONFIG: path.join(root, "coord", "project.config.js"), CODEX_THREAD_ID: "recovery-characterization" };
  for (const key of SESSION_KEYS) delete env[key];
  return env;
}

// Ambient environment the runner receives unscrubbed: every session key set to a live
// value and the provider detection flags set. The runner must scrub it exactly as the
// suite's scrubbed env does for the CLI side.
function ambientEnv(env) {
  const raw = { ...env, CLAUDECODE: "1", GEMINI_AGENT: "1", GROK_AGENT: "1", COORD_PROVIDER_SESSION_ID: "ambient" };
  for (const key of SESSION_KEYS) raw[key] = "a11-ambient0001";
  return raw;
}

function cliSpawn(root, args, env) {
  return spawnSync(process.execPath, [path.join(root, "coord", "scripts", "governance.js"), ...args], { cwd: root, env, encoding: "utf8", timeout: 45000 });
}

// Setup is run through the step runner, so the runner side also proves the approved
// reconcile and the agentid bind. Both sides use the same arguments and expected status.
function approvalForArgs(args) {
  if (args[0] === "reconcile" && args.includes("--human-admin-override")) {
    return { verb: "reconcile", ticket: "control-plane" };
  }
  if (args[0] === "claim" && args.includes("--transfer-to") && args.includes("--human-admin-override")) {
    return { verb: "claim --transfer-to", ticket: args[1] };
  }
  if (args[0] === "recover" && args.includes("--human-admin-override")) {
    return { verb: "recover --human-admin-override", ticket: args[1] };
  }
  return null;
}

function runSignedFixtureCommand(root, args, env, approval, runStep, { requireSuccess = false } = {}) {
  const run = () => runStep(root, args, env, approval);
  const scope = approvalForArgs(args);
  if (!scope) return run();
  const refused = run();
  const refusalText = `${refused.stdout || ""}\n${refused.stderr || ""}`;
  const digest = /Subject digest: ([0-9a-f]{64})/.exec(refusalText);
  assert.notEqual(refused.status, 0, `unsigned ${scope.verb} must refuse before fixture signing`);
  if (!digest) {
    assert.equal(requireSuccess, false, `unsigned ${scope.verb} positive setup must reach the signed-approval gate: ${refusalText}`);
    return refused;
  }
  const journalPath = path.join(root, "coord", ".runtime", "governance-events.ndjson");
  const readJournal = () => fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const refusal = readJournal().findLast((event) => event.event === "approval.refused" &&
    event.command === scope.verb && event.ticket === scope.ticket && event.subject_sha256 === digest[1]);
  if (refused.status !== 0 && digest) {
    assert.ok(refusal, `unsigned ${scope.verb} must journal the exact refusal digest before signing`);
    assert.match(refusal.subject_sha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof refusal.refused, "string");
    assert.equal(refusal.override_reason, args[args.indexOf("--human-admin-override") + 1]);
  }
  const session = approval.login({ ...scope, subject_sha256: digest[1] });
  const signed = run();
  if (requireSuccess) assert.equal(signed.status, 0, `signed ${scope.verb} must succeed: ${signed.stdout}\n${signed.stderr}`);
  const verified = readJournal().findLast((event) => event.event === "approval.verified" &&
    event.command === scope.verb && event.ticket === scope.ticket);
  assert.ok(verified, `signed ${scope.verb} retry must journal a verified approval`);
  assert.match(verified.subject_sha256, /^[0-9a-f]{64}$/);
  assert.equal(verified.subject_sha256, digest[1], "verified audit subject must equal the first refusal digest");
  assert.match(verified.approval_record, /^[0-9a-f]{32}$/);
  assert.match(verified.human_admin_session, /^[0-9a-f]{32}$/);
  assert.equal(verified.human_admin_session, session.session_id);
  assert.equal(verified.approval_verified, `key_id=${approval.keyId}`);
  assert.equal(verified.override_reason, args[args.indexOf("--human-admin-override") + 1]);
  return signed;
}

function setupFixture(root, gitEnv, runStep, rawEnv, approval) {
  buildFixture(root, gitEnv);
  const env = fixtureEnv(root, gitEnv);
  const run = (...args) => runStep(root, args, rawEnv || env, approval);
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, `${args.join(" ")}\n${r.stdout}\n${r.stderr}`); return r; };
  // Journal initialization, as reconcileFixture() in the suite: render views, then an approved reconcile.
  require(path.join(root, "coord", "board", "board.js")).renderBoardArtifacts();
  const reconcile = withApprovedPacket(["reconcile", "--reason", "initialize isolated regression fixture", "--human-admin-override", "Fixture administrator approves this isolated synthetic state"], (args) => run(...args));
  const signedReconcile = runSignedFixtureCommand(root, reconcile, rawEnv || env, approval, runStep, { requireSuccess: true });
  assert.equal(signedReconcile.status, 0);
  ok("agentid", "--owner", NEW_OWNER);
  return env;
}

// The verb set. Expected refusals: the first claim, recover without an override, reconcile
// without an approved packet, and claim/recover against an already-bound lock.
const STEPS = [
  ["agent-status"],
  ["claim", TICKET, "--transfer-to", NEW_OWNER],
  ["recover", TICKET],
  ["claim", TICKET, "--transfer-to", NEW_OWNER, "--human-admin-override", "test authorization"],
  ["file-ticket", "TEST-002", "--repo", "X", "--type", "bug", "--pri", "P2", "--description", "Other ticket", "--with-prompt"],
  ["sync"],
  ["agent-release", NEW_OWNER, "--reason", "retry"],
  ["start", "TEST-002"],
  ["agentid"],
  ["recover", TICKET, "--human-admin-override", "preserve original owner"],
  ["reconcile", "--reason", "reason is not approval"],
  ["resume", TICKET],
  // COORD-1023: plan (read) and register-prompt (write, plus an expected refusal without a body file).
  ["plan", TICKET],
  ["plan"],
  ["register-prompt", "TEST-002", "--body-file", "register-body.md"],
  ["register-prompt", "TEST-002"],
];

// Replaces only per-run values; the fixture root is replaced by its own path.
function normalize(text, root) {
  return String(text)
    .split(root).join("<ROOT>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TS>")
    .replace(/\b[0-9a-f]{40}\b/g, "<SHA>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>")
    .replace(/\ba\d{2,3}-[a-z0-9]{8}\b/g, "<SID>")
    .replace(/unknown-host:\d+/g, "unknown-host:<PID>")
    .replace(/\bitx-[a-z0-9-]+/g, "<TXN>")
    .replace(/Subject digest: [0-9a-f]{64}/g, "Subject digest: <APPROVAL_SUBJECT>")
    .replace(/"pid":\s*\d+/g, '"pid": <PID>');
}

function normalizedJournal(root) {
  const rel = "coord/.runtime/governance-events.ndjson";
  const journalPath = path.join(root, rel);
  if (!fs.existsSync(journalPath)) return null;
  const records = fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const chain = require(path.join(root, "coord", "engine", "scripts", "journal-chain.js"));
  const actual = chain.verifyGovernanceChain(records);
  assert.equal(actual.ok, true, `fixture journal chain must verify before normalization: ${JSON.stringify(actual.broken)}`);
  const normalized = [];
  for (const record of records) {
    const approvalEvent = record.event === "approval.refused" || record.event === "approval.verified";
    if (approvalEvent) {
      assert.match(record.subject_sha256, /^[0-9a-f]{64}$/, `${record.event} must retain a valid original subject digest`);
      assert.equal(typeof record.command, "string");
      assert.equal(typeof record.ticket, "string");
      assert.equal(typeof record.override_reason, "string");
      if (record.event === "approval.refused") assert.equal(typeof record.refused, "string");
      if (record.event === "approval.verified") {
        assert.match(record.approval_record, /^[0-9a-f]{32}$/);
        assert.match(record.human_admin_session, /^[0-9a-f]{32}$/);
        assert.match(record.approval_verified, /^key_id=[0-9a-f]{64}$/);
      }
    }
    const detail = record.details && typeof record.details === "object" ? record.details : null;
    if (detail) {
      for (const name of ["approval_subject_sha256", "approved_digest"]) {
        if (Object.hasOwn(detail, name) && detail[name] !== null) {
          assert.match(detail[name], name === "approval_subject_sha256" ? /^[0-9a-f]{64}$/ : /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, `${name} must be null or a valid digest before normalization`);
        }
      }
      for (const name of ["approval_record", "human_admin_session"]) {
        if (Object.hasOwn(detail, name) && detail[name] !== null) assert.match(detail[name], /^[0-9a-f]{32}$/, `${name} must be null or a valid identifier before normalization`);
      }
      if (detail.snapshot_recovery && Object.hasOwn(detail.snapshot_recovery, "approved_digest") && detail.snapshot_recovery.approved_digest !== null) {
        assert.match(detail.snapshot_recovery.approved_digest, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "snapshot recovery approved digest must be null or valid before normalization");
      }
    }
    const next = JSON.parse(normalize(JSON.stringify(record), root));
    if (approvalEvent) next.subject_sha256 = "<APPROVAL_SUBJECT>";
    if (record.event === "approval.verified") {
      next.approval_record = "<APPROVAL_RECORD>";
      next.human_admin_session = "<APPROVAL_SESSION>";
    }
    const details = next.details && typeof next.details === "object" ? next.details : null;
    if (details) {
      if (typeof details.approval_subject_sha256 === "string") details.approval_subject_sha256 = "<APPROVAL_SUBJECT>";
      if (typeof details.approval_record === "string") details.approval_record = "<APPROVAL_RECORD>";
      if (typeof details.human_admin_session === "string") details.human_admin_session = "<APPROVAL_SESSION>";
      if (details.snapshot_recovery && typeof details.snapshot_recovery.approved_digest === "string") {
        details.snapshot_recovery.approved_digest = "<APPROVAL_SUBJECT>";
      }
    }
    if (typeof next.prev_event_hash === "string" && next.prev_event_hash !== "genesis" && normalized.length > 0) {
      next.prev_event_hash = chain.hashGovernanceEventRecord(normalized[normalized.length - 1]);
    }
    normalized.push(next);
  }
  return normalized.map((record) => JSON.stringify(record)).join("\n") + (normalized.length ? "\n" : "");
}

function snapshot(root) {
  const files = {};
  const take = (rel) => { const abs = path.join(root, rel); if (fs.existsSync(abs)) files[rel] = normalize(fs.readFileSync(abs, "utf8"), root); };
  take("coord/board/tasks.json");
  take("coord/.runtime/agent_sessions.json");
  const journal = normalizedJournal(root);
  if (journal !== null) files["coord/.runtime/governance-events.ndjson"] = journal;
  const locks = path.join(root, "coord", ".runtime", "locks");
  if (fs.existsSync(locks)) for (const name of fs.readdirSync(locks).sort()) take(path.join("coord", ".runtime", "locks", name));
  return files;
}

function runSequence(label, runStep, { gitEnv = {}, rawEnv = false, approval } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `coord1022-${label}-`));
  try {
    fs.rmSync(path.join(approval.dir, "session.json"), { force: true });
    const env = setupFixture(root, gitEnv, runStep, rawEnv ? ambientEnv(fixtureEnv(root, gitEnv)) : null, approval);
    const steps = STEPS.map((args) => {
      const r = runSignedFixtureCommand(root, args, rawEnv ? ambientEnv(env) : env, approval, runStep, {
        requireSuccess: args[0] === "claim" && args.includes("--transfer-to") && args.includes("--human-admin-override"),
      });
      return { args: args.join(" "), status: r.status, signal: r.signal, stdout: normalize(r.stdout, root), stderr: normalize(r.stderr, root) };
    });
    return { steps, files: snapshot(root) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const cliStep = (root, args, env, approval) => approval.runCli(path.join(root, "coord"), args, { cwd: root, env, encoding: "utf8", timeout: 45000 });
const runnerStep = (root, args, env, approval) => runFixtureGovernance(root, args, env, approval.client());

function assertEqualRuns(actual, expected, label) {
  assert.equal(actual.steps.length, expected.steps.length, `${label}: step count`);
  expected.steps.forEach((step, index) => {
    const got = actual.steps[index];
    for (const field of ["status", "signal", "stdout", "stderr"]) assert.equal(got[field], step[field], `${label}: step ${index} (${step.args}) ${field}`);
  });
  for (const name of new Set([...Object.keys(expected.files), ...Object.keys(actual.files)])) {
    const a = (expected.files[name] || "").split("\n");
    const b = (actual.files[name] || "").split("\n");
    const at = a.findIndex((line, i) => line !== b[i]);
    assert.equal(actual.files[name], expected.files[name], `${label}: bytes of ${name} differ at line ${at}: cli=${a[at]} runner=${b[at]}`);
  }
}

test("in-process fixture runner matches the CLI spawn on identical fresh fixtures", () => {
  const approval = createApprovalFixture({ allowedVerbs: ["reconcile", "claim --transfer-to", "recover --human-admin-override"] });
  try {
    const cli = runSequence("cli", cliStep, { approval });
    const inproc = runSequence("runner", runnerStep, { approval });
    assertEqualRuns(inproc, cli, "default fixture");
    // The characterization must exercise both paths: successes and expected refusals.
    assert.ok(cli.steps.filter((s) => s.status === 0).length >= 2, "representative set includes successful verbs");
    assert.ok(cli.steps.filter((s) => s.status !== 0).length >= 4, "representative set includes expected refusals");
  } finally { approval.cleanup(); }
});

test("COORD-880/883 env scrub: ambient session and provider keys reach neither side", () => {
  const approval = createApprovalFixture({ allowedVerbs: ["reconcile", "claim --transfer-to", "recover --human-admin-override"] });
  try {
    const cli = runSequence("cli-scrub", cliStep, { approval });
    const inproc = runSequence("runner-scrub", runnerStep, { rawEnv: true, approval });
    assertEqualRuns(inproc, cli, "env scrub");
    // Neither side may report an ambient session: the agentid verb sees no session identity.
    const agentid = cli.steps.find((s) => s.args === "agentid");
    assert.doesNotMatch(agentid.stdout + agentid.stderr, /a11-ambient0001/);
  } finally { approval.cleanup(); }
});

test("gitEnv fixture variant (COORD-767 shape) matches the CLI spawn", () => {
  const proof = fs.mkdtempSync(path.join(os.tmpdir(), "coord1022-gitenv-"));
  try {
    const globalConfig = path.join(proof, "global.config");
    fs.writeFileSync(globalConfig, "[gc]\n autoDetach = true\n[maintenance]\n autoDetach = true\n");
    const gitEnv = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
    const approval = createApprovalFixture({ allowedVerbs: ["reconcile", "claim --transfer-to", "recover --human-admin-override"] });
    try {
      const cli = runSequence("cli-gitenv", cliStep, { gitEnv, approval });
      const inproc = runSequence("runner-gitenv", runnerStep, { gitEnv, approval });
      assertEqualRuns(inproc, cli, "gitEnv fixture");
    } finally { approval.cleanup(); }
  } finally {
    fs.rmSync(proof, { recursive: true, force: true });
  }
});

test("runner isolation: back-to-back and interleaved calls leave process state untouched", () => {
  const approval = createApprovalFixture({ allowedVerbs: ["reconcile", "claim --transfer-to", "recover --human-admin-override"] });
  try {
  const cli = runSequence("cli-iso", cliStep, { approval });
  const processState = () => ({
    env: { ...process.env }, cwd: process.cwd(), argv: [...process.argv], exitCode: process.exitCode,
    listeners: ["exit", "SIGINT", "SIGTERM"].map((event) => [event, process.listenerCount(event)]),
  });
  const before = processState();
  const first = runSequence("runner-iso-a", (root, args, env, client) => {
    const result = runFixtureGovernance(root, args, env, client.client());
    assert.deepEqual(processState(), before, `process state after ${args.join(" ")}`);
    return result;
  }, { approval });
  const second = runSequence("runner-iso-b", runnerStep, { approval });
  assertEqualRuns(first, cli, "first back-to-back run");
  assertEqualRuns(second, cli, "second back-to-back run");
  // Interleaved: a second fixture's call between the first fixture's calls must not see its state.
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord1022-probe-"));
  try {
    fs.rmSync(path.join(approval.dir, "session.json"), { force: true });
    const probeEnv = setupFixture(probeRoot, {}, cliStep, null, approval);
    const interleaved = runSequence("runner-iso-c", (root, args, env) => {
      const probe = runFixtureGovernance(probeRoot, ["agentid"], probeEnv, approval.client());
      assert.equal(probe.status, 0, "interleaved fixture still answers");
      return runnerStep(root, args, env, approval);
    }, { approval });
    assertEqualRuns(interleaved, cli, "interleaved run");
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
  assert.deepEqual(processState(), before, "process state after the whole characterization");
  } finally { approval.cleanup(); }
});

// COORD-1023 state-mutation canary. A cached engine graph would let module-level state written by
// one call reach the next call. The canary fixture's entry bumps a module-level counter in a
// fixture-owned engine module and prints it; every call must print 1, and no module instance from
// the fixture may remain in the require cache after a call.
test("state-mutation canary: module-level engine state written by one call is not seen by the next", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1023-canary-"));
  try {
    const coord = path.join(root, "coord");
    fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(coord, "engine", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(coord, "engine", "scripts", "canary-state.js"), "let count = 0;\nmodule.exports = { bump: () => ++count };\n");
    fs.writeFileSync(path.join(coord, "scripts", "governance.js"),
      "\"use strict\";\nconst state = require(\"../engine/scripts/canary-state.js\");\nexports.main = () => { process.stdout.write(`count=${state.bump()}\\n`); };\n");
    const env = { ...process.env };
    for (const key of SESSION_KEYS) delete env[key];
    const outputs = [];
    for (let i = 0; i < 3; i++) {
      const r = runFixtureGovernance(root, ["canary"], env);
      assert.equal(r.status, 0, r.stderr);
      outputs.push(r.stdout);
      const leaked = Object.keys(require.cache).filter((key) => key.startsWith(coord + path.sep));
      assert.deepEqual(leaked, [], `call ${i + 1} left fixture modules in the require cache`);
    }
    assert.deepEqual(outputs, ["count=1\n", "count=1\n", "count=1\n"], "module-level state must be fresh on every call");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
