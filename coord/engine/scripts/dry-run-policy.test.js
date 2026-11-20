"use strict";

// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntimeLocks();
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const { gitFixture, gitFixtureEnv, gitBareRemote } = require("./test-git-fixture.js");
const testUtils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const { startManagedSession } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/managed-auto-runner.js"));
const { state } = require("./governance-context.js");
const { DRY_RUN_VERBS, supportsDryRun, assertDryRunSupported } = require("./dry-run-policy.js");
const { collectDispatchCommandVerbs } = require("./verb-parity.js");
const declaration = require("./command-declaration.js");

// COORD-922: `--dry-run` is a global flag, so a verb could parse it and ignore
// it. `claim --transfer-to ... --dry-run` performed the real transfer. These
// tests hold the one declared per-verb list (dry-run-policy.js) to its promise:
// every declared verb leaves the governed fixture byte-identical, and every
// other dispatched verb refuses the flag before any effect.

// ADR 0031 (COORD-1034): the real transfer needs a fixture-signed record for its exact digest.
const { after } = require("node:test");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");
const approvalFixture = createApprovalFixture();
after(() => approvalFixture.cleanup());
const { executeCommand, setupCoord003Workspace } = testUtils;
const OWNER = "claudea0000";
const TARGET = "claudea99";
const TICKET = "MSRV-922";
const CLI_SOURCE = fs.readFileSync(path.join(__dirname, "cli.js"), "utf8");

function envFor(thread) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/_(?:SESSION|THREAD|INSTANCE)_ID$/.test(key)) delete env[key];
  }
  return { ...env, CLAUDE_SESSION_ID: thread };
}
const runWithApproval = (run) => withApprovalTestClient(path.resolve(__dirname, "..", ".."), approvalFixture.client(), run);
const asOwner = (args) => executeCommand(args, { env: envFor("coord003-thread") });
const asTarget = (args) => runWithApproval(() => executeCommand(args, { env: envFor("coord922-target-thread") }));

// Every file under the fixture's coord root: board, journal, snapshots, locks,
// agent registry, sessions, plan records, prompts, QUESTIONS.md and rendered views.
function snapshotTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[path.relative(root, full)] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  walk(root);
  return out;
}

function workspace(body, options = {}) {
  const ctx = setupCoord003Workspace("coord922-dry-run-", TICKET, OWNER, { withCommit: true, isolateBoardValidation: true, ...options });
  try {
    // Settle first-use state: any governed read mirrors the agent registry to
    // its legacy compatibility path once. A real install already has it.
    const settled = asOwner(["ticket", TICKET]);
    assert.equal(settled.ok, true, settled.error);
    assert.ok(fs.existsSync(path.join(ctx.coordRoot, "agents.json")));
    return body(ctx);
  } finally {
    ctx.restore();
  }
}

function assertUnchanged(ctx, run) {
  const before = snapshotTree(ctx.coordRoot);
  const result = run();
  assert.deepEqual(snapshotTree(ctx.coordRoot), before, "the governed fixture is byte-identical after the call");
  return result;
}

// One fixture per declared verb. `setup` runs before the snapshot and puts the
// fixture in the state where the verb's preview has something to report.
let promoteFixture = null;
const DRY_RUN_FIXTURES = {
  claim: {
    run: () => asTarget(["claim", TICKET, "--transfer-to", TARGET, "--human-admin-override", "COORD-922 preview", "--dry-run"]),
    check: (out) => {
      assert.deepEqual(out.owner, { from: OWNER, to: TARGET });
      assert.equal(out.dry_run, true);
    },
  },
  "repair-lock-head": {
    // COORD-978: the preview reports the lock head, recorded heads, containment and the authority verdict.
    run: () => asOwner(["repair-lock-head", TICKET, "--dry-run"]),
    check: (out) => {
      assert.equal(out.status, "preview");
      assert.equal(out.writes, "none");
      assert.match(out.expected_state_digest, /^[0-9a-f]{64}$/);
    },
  },
  reconcile: {
    setup: (ctx) => fs.appendFileSync(path.join(ctx.coordRoot, "QUESTIONS.md"), "unjournaled edit\n"),
    run: () => asOwner(["reconcile", "--reason", "COORD-922 inspect", "--dry-run"]),
    check: (out) => assert.equal(out.status, "dry_run"),
  },
  // COORD-1026 / ADR 0028: promote --dry-run previews dev -> staging against a local bare remote the
  // fixture creates. The byte comparison below proves it writes nothing under the governed fixture
  // (no journal, no record, no plan). The integration-authority holder is the fixture owner.
  promote: {
    setup: (ctx) => {
      const gitIn = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitFixtureEnv() } }).trim();
      const remote = gitBareRemote("coord-1026-dry-run-");
      gitIn(ctx.backendRoot, ["remote", "set-url", "origin", remote]);
      const base = gitIn(ctx.backendRoot, ["rev-parse", "HEAD"]);
      const policyPath = path.join(ctx.backendRoot, "coord", "engine", "test-policy.json");
      fs.mkdirSync(path.dirname(policyPath), { recursive: true });
      const policy = `${JSON.stringify({ policy_version: 1, promotion_edges: { "dev->staging": { gates: ["full-suite-sharded-node22"] } } }, null, 2)}\n`;
      fs.writeFileSync(policyPath, policy);
      gitIn(ctx.backendRoot, ["add", "coord/engine/test-policy.json"]);
      gitIn(ctx.backendRoot, ["commit", "-q", "-m", "COORD-1026 fixture policy"]);
      const devTip = gitIn(ctx.backendRoot, ["rev-parse", "HEAD"]);
      gitIn(ctx.backendRoot, ["push", "-q", "origin", `${devTip}:refs/heads/dev`, `${base}:refs/heads/staging`]);
      const manifestPath = path.join(remote, "..", `coord-1026-manifest-${devTip.slice(0, 8)}.json`);
      // COORD-1043: promote refuses a manifest with no journaled producer event, so the manifest comes from
      // the real producer: a stub gate runner reports pass and the governed appender journals the event.
      const passGatePath = path.join(remote, "..", "coord-1026-pass-gate.js");
      fs.writeFileSync(passGatePath, "\"use strict\";\nconst fs = require(\"node:fs\");\nfs.writeFileSync(process.argv[process.argv.indexOf(\"--report\") + 1], JSON.stringify({ result: \"pass\" }));\n");
      const passingGate = { lane: "node22", argv: [passGatePath] };
      const produced = require("./promote.js").produceGateManifest({ edge: "dev->staging", commit: devTip, out: manifestPath }, {
        repo: ctx.backendRoot,
        gateRuns: { "full-suite-sharded-node22": passingGate },
        nodeBinDir: { node22: path.dirname(process.execPath) },
        appendGovernanceEvent: (event) => require("./lifecycle.js").__testing.appendGovernanceEvent(event),
      });
      assert.equal(produced.produced, true, "the fixture manifest is produced and journaled");
      fs.writeFileSync(path.join(ctx.coordRoot, ".runtime", "integration-authority.json"), JSON.stringify({
        schema: "coord.integration-authority/v1",
        domain: { runtime_dir: ctx.coordRoot, board_path: ctx.boardPath },
        holder: { handle: OWNER, session_id: null, thread_id: "coord003-thread", granted_at: new Date().toISOString(), granted_via: "COORD-1026 fixture", reason: "dry-run proof" },
        operation: null,
        history: [],
      }));
      promoteFixture = { remote, devTip, manifestPath };
    },
    run: (ctx) => {
      const prior = process.env.COORD_PROMOTE_REPO;
      process.env.COORD_PROMOTE_REPO = ctx.backendRoot;
      try {
        return asOwner(["promote", "--from", "dev", "--to", "staging", "--commit", promoteFixture.devTip, "--gate-manifest", promoteFixture.manifestPath, "--dry-run"]);
      } finally {
        if (prior === undefined) delete process.env.COORD_PROMOTE_REPO;
        else process.env.COORD_PROMOTE_REPO = prior;
      }
    },
    check: (out) => {
      assert.equal(out.dry_run, true);
      assert.equal(out.promoted, false);
      assert.equal(out.plan.commit, promoteFixture.devTip);
      assert.equal(out.plan.edge, "dev->staging");
      fs.rmSync(promoteFixture.remote, { recursive: true, force: true });
      fs.rmSync(promoteFixture.manifestPath, { force: true });
      promoteFixture = null;
    },
  },
  "record-managed-evidence": {
    setup: (ctx) => {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ctx.worktreePath, encoding: "utf8" }).trim();
      const session = startManagedSession({
        ticket: TICKET, session: "sess-922", owner: OWNER, base_sha: head, worktree: ctx.worktreePath,
        provider: { name: "codex", version: "1.0.0", supported: true, enforceable: ["command", "read", "write"] },
        controls: { hooks: true, sandbox: true, environment: true }, environment: { PATH: process.env.PATH },
        runtime_dir: state.RUNTIME_DIR, broker_capabilities: [], broker_targets: [],
      });
      session.end("done");
    },
    run: () => asOwner(["record-managed-evidence", TICKET, "--dry-run"]),
    check: (out) => assert.equal(out.status, "dry-run"),
  },
  "retire-stale-drift-notes": {
    run: () => asOwner(["retire-stale-drift-notes", "--dry-run"]),
    check: (out) => assert.equal(out.dry_run, true),
  },
  "reap-gate-procs": {
    run: () => asOwner(["reap-gate-procs", "--dry-run"]),
    check: (out) => assert.equal(out.dry_run, true),
  },
  "coverage-rollup": {
    run: () => asOwner(["coverage-rollup", "--json", "--dry-run"]),
    check: (out) => assert.equal(out.dry_run, true),
  },
  "resolve-question": {
    run: () => asOwner(["resolve-question", "--dry-run"]),
    check: (out) => assert.equal(out.status, "dry_run"),
  },
  "quality-scan": {
    run: (ctx) => {
      const exitCode = process.exitCode;
      try {
        return asOwner(["quality-scan", "--dry-run", "--root", ctx.backendRoot, "--board", ctx.boardPath, "--cap", "0"]);
      } finally {
        assert.equal(process.exitCode, 0, "the scan's dry run exits 0");
        process.exitCode = exitCode;
      }
    },
    check: () => {},
  },
};

test("COORD-922: every verb that accepts --dry-run leaves board, journal, locks, sessions, plans and rendered views byte-identical", () => {
  assert.deepEqual(Object.keys(DRY_RUN_FIXTURES).sort(), Object.keys(DRY_RUN_VERBS).sort(),
    "each declared --dry-run verb needs a byte-identical fixture here");
  for (const [verb, fixture] of Object.entries(DRY_RUN_FIXTURES)) {
    workspace((ctx) => {
      if (fixture.setup) fixture.setup(ctx);
      const result = assertUnchanged(ctx, () => fixture.run(ctx));
      assert.equal(result.ok, true, `${verb}: ${result.error}`);
      fixture.check(verb === "quality-scan" ? null : JSON.parse(result.stdout));
    });
  }
});

test("COORD-922: every dispatched verb without a declared preview refuses --dry-run before any effect", () => {
  const verbs = [...collectDispatchCommandVerbs(CLI_SOURCE)];
  assert.ok(verbs.length >= 100, "the router's verb set is read from the live dispatch switch");
  const undeclared = verbs.filter((verb) => !supportsDryRun(verb));
  workspace((ctx) => {
    for (const verb of undeclared) {
      const result = assertUnchanged(ctx, () => asOwner([verb, TICKET, "--dry-run"]));
      assert.equal(result.ok, false, `${verb} accepted --dry-run without declaring support in dry-run-policy.js`);
      assert.match(result.error, new RegExp(`^${verb} does not support --dry-run: it has no read-only preview, so the flag is refused and nothing ran\\.`));
    }
  });
});

// COORD-1021 (c): the guard placement, derived from the declaration. Every declared spelling is routed to a
// recording spy; --dry-run is then sent to each. An undeclared spelling must be refused by the guard and
// its route must not run; a declared preview must reach its route. No switch text is read.
test("COORD-1021: the dry-run guard runs before every route, for every spelling the declaration names", () => {
  const { dispatchCommand, ROUTES } = require("./cli.js").__testing;
  const original = new Map(ROUTES);
  const reached = [];
  try {
    for (const spelling of declaration.SPELLINGS) {
      ROUTES.set(spelling, (command) => { reached.push(command); return "routed"; });
    }
    for (const verb of declaration.SPELLINGS) {
      reached.length = 0;
      if (supportsDryRun(verb)) {
        assert.equal(dispatchCommand(verb, ["X-1", "--dry-run"]), "routed", `${verb} declares a preview and must reach it`);
        assert.deepEqual(reached, [verb], `${verb} reached its route once`);
      } else {
        assert.throws(() => dispatchCommand(verb, ["X-1", "--dry-run"]), /does not support --dry-run/, `${verb} refuses --dry-run`);
        assert.deepEqual(reached, [], `${verb} refused before its route ran`);
      }
    }
  } finally {
    for (const [name, route] of original) ROUTES.set(name, route);
  }
});

test("COORD-922: the declaration names only dispatched verbs and the router checks it before any handler", () => {
  const verbs = collectDispatchCommandVerbs(CLI_SOURCE);
  assert.deepEqual(Object.keys(DRY_RUN_VERBS).filter((verb) => !verbs.has(verb)), [], "a declared verb the router no longer dispatches");
  // COORD-1021: the guard placement is checked behaviourally against the declaration (see the next test).
  const refusals = [];
  assertDryRunSupported("start", ["X-1", "--dry-run"], (message) => refusals.push(message));
  assertDryRunSupported("start", ["X-1"], (message) => refusals.push(message));
  assertDryRunSupported("reconcile", ["--dry-run"], (message) => refusals.push(message));
  assertDryRunSupported("start", "--dry-run", (message) => refusals.push(message));
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /Verbs with a declared --dry-run preview: claim, reconcile,/);
  const help = require("./cli.js").__testing.buildHelpText({ all: true });
  const note = help.split("\n").find((line) => line.includes('"--dry-run" is honoured only by the verbs declared'));
  assert.ok(note, "gov help documents the declaration");
  for (const verb of Object.keys(DRY_RUN_VERBS)) assert.ok(note.includes(verb), `gov help names ${verb} as a --dry-run verb`);
});

test("COORD-922 incident: claim --transfer-to --dry-run previews the owner, workspace and provenance changes and transfers nothing", () => {
  workspace((ctx) => {
    const lockBefore = JSON.parse(fs.readFileSync(ctx.lockPath, "utf8"));
    const result = assertUnchanged(ctx, () => asTarget(["claim", TICKET, "--transfer-to", TARGET, "--human-admin-override", "restart continuation", "--dry-run"]));
    assert.equal(result.ok, true, result.error);
    const out = JSON.parse(result.stdout);
    assert.equal(out.writes, "none");
    assert.equal(out.status, "doing");
    assert.deepEqual(out.owner, { from: OWNER, to: TARGET });
    assert.deepEqual(out.workspace, {
      lock: path.relative(path.resolve(__dirname, "..", ".."), ctx.lockPath),
      lock_recreated: false,
      worktree: lockBefore.worktree,
      branch: lockBefore.branch,
      kept: true,
      workspace_owner: { from: null, to: OWNER },
    });
    assert.equal(out.provenance.prior_entries, 0);
    assert.deepEqual(out.provenance.appended, {
      from: OWNER, to: TARGET, workspace_owner: OWNER, reason: "restart continuation", previous_session_id: `${OWNER}-coord003`,
    });
    assert.equal(out.provenance.journal_event, "claim-ticket");
    assert.equal(out.provenance.journal_details.transfer_to, TARGET);
    assert.equal(out.provenance.journal_details.legacy_force_alias, false);
    // ADR 0031: the preview names the signed approval the human must give and authorizes nothing.
    assert.equal(out.approval.signed_approval, "required");
    assert.equal(out.approval.authorized, false);
    assert.equal(out.approval.verb, "claim --transfer-to");
    assert.equal(out.approval.ticket, TICKET);
    assert.match(out.approval.subject_sha256, /^[0-9a-f]{64}$/);
    assert.equal(out.approval.login_command, `sudo -u coordapprove /usr/local/libexec/coord-approval/coord-approve login --verb claim --transfer-to --ticket ${TICKET} --subject ${out.approval.subject_sha256} --ttl-minutes 15`);
    assert.ok(out.not_previewed.length > 0, "the preview names what it does not simulate");

    // The real transfer still works and matches the preview.
    // The real transfer is run from the target's own thread, which it binds.
    // A bare override string is refused; the human's login for the previewed digest is then the only way through.
    const bare = asTarget(["claim", TICKET, "--transfer-to", TARGET, "--human-admin-override", "restart continuation"]);
    assert.equal(bare.ok, false);
    assert.match(bare.error, /requires a signed human-admin approval \(ADR 0031\)/);
    approvalFixture.login({
      verb: "claim --transfer-to",
      ticket: TICKET,
      subject_sha256: out.approval.subject_sha256,
    });
    const real = asTarget(["claim", TICKET, "--transfer-to", TARGET, "--human-admin-override", "restart continuation"]);
    assert.equal(real.ok, true, real.error);
    const lockAfter = JSON.parse(fs.readFileSync(ctx.lockPath, "utf8"));
    assert.equal(lockAfter.owner, out.owner.to);
    assert.equal(lockAfter.workspace_owner, out.workspace.workspace_owner.to);
    assert.equal(lockAfter.worktree, out.workspace.worktree);
    assert.deepEqual(
      { ...lockAfter.transfer_provenance[0], at: undefined },
      { ...out.provenance.appended, at: undefined },
    );
  });
});

test("COORD-922: the canonical transfer-preview module preserves lock provenance and rejects invalid source ownership", () => {
  const { previewClaimTransfer } = require("./claim-transfer-preview.js");
  const run = (row, lock) => {
    const deps = {
      fail(message) { throw new Error(message); },
      state: { PLAN_RECORDS_DIR: null, LEGACY_PLAN_RECORDS_DIR: null },
      STATUS: { TODO: "todo", DEFERRED: "deferred" },
      readBoard: () => ({}),
      getTicketRef: () => ({ row }),
      isDoingStatus: (status) => status === "doing",
      canonicalizeOwnerOrFail: (owner) => owner,
      readAgentsRegistry: () => [],
      resolveAgentIdentifier: () => ({ agent: { status: "active", handle: "new-owner", id: "new-agent" } }),
      findLockForTicket: () => lock,
      detectActiveSameOwnerOtherThread: () => ({ present: false }),
      buildActiveSameOwnerOtherThreadMessage: () => "unexpected live owner",
      currentRuntimeThreadId: () => "thread-current",
      readAgentSessions: () => [],
      detectRuntimeProvider: () => "openai",
      identityV2: { readEnvIdentity: () => ({ present: false }) },
      resolveHumanAdminOverride: () => ({ reason: "reviewed transfer", legacyForceAlias: false }),
      COORD_DIR: "/fixture/coord",
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
      return previewClaimTransfer("COORD-922", { transferTo: "new-owner" }, deps);
    } finally {
      console.log = originalLog;
    }
  };

  assert.throws(() => run({ Status: "todo", Owner: "old-owner" }, null), /there is no claimed ticket to transfer/);
  assert.throws(() => run({ Status: "doing", Owner: "" }, null), /under owner unassigned: there is no claimed ticket to transfer/,
    "a missing owner uses the explicit unassigned label and cannot be transferred");
  assert.throws(() => run({ Status: "doing", Owner: "unassigned" }, null), /there is no claimed ticket to transfer/,
    "the sentinel owner cannot be treated as a claimed ticket even when status is doing");
  assert.throws(() => run({ Status: "doing", Owner: "new-owner" }, null), /already owned by new-owner/);

  const lock = {
    owner: "old-owner", workspace_owner: "   ", worktree: "/worktree", branch: "feature/922",
    path: "/fixture/coord/locks/COORD-922.lock", transfer_provenance: "malformed", session_id: null,
  };
  const preview = run({ Status: "doing", Owner: "old-owner" }, lock);
  assert.deepEqual(preview.workspace, {
    lock: "locks/COORD-922.lock", lock_recreated: false, worktree: "/worktree", branch: "feature/922",
    kept: true, workspace_owner: { from: null, to: "old-owner" },
  });
  assert.equal(preview.provenance.prior_entries, 0, "malformed provenance is not treated as a valid prior journal count");
  assert.equal(preview.provenance.appended.previous_session_id, null);

  const journaledLock = { ...lock, transfer_provenance: [
    { from: "first-owner", to: "old-owner", reason: "first handoff" },
    { from: "old-owner", to: "old-owner", reason: "reclaim" },
  ] };
  const journaledPreview = run({ Status: "doing", Owner: "old-owner" }, journaledLock);
  assert.equal(journaledPreview.provenance.prior_entries, 2,
    "a structurally present transfer journal is counted for the prospective append");

  const noLock = run({ Status: "doing", Owner: "old-owner" }, null);
  assert.equal(noLock.workspace.lock_recreated, true);
  assert.equal(noLock.provenance.journal_details.recreated_lock, true);
});

test("claim transfer preview binds the preserved PR workspace and active local session", (t) => {
  const { previewClaimTransfer } = require("./claim-transfer-preview.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-claim-review-preview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(console, "log", () => {});
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree);
  gitFixture(worktree, ["init", "-q", "-b", "review-branch"]);
  gitFixture(worktree, ["commit", "--allow-empty", "-qm", "review fixture"]);
  const head = gitFixture(worktree, ["rev-parse", "HEAD"]);
  const prUrl = "https://github.com/example/fixture/pull/1";
  const journal = path.join(root, "journal.ndjson");
  const evidence = { command: "move-review", ticket: TICKET, result: "succeeded", details: {
    workspace_evidence: { branch: "review-branch", worktree, head, pr_url: prUrl, pr_head_ref: "review-branch" },
  } };
  fs.writeFileSync(journal, JSON.stringify(evidence) + "\n");
  const before = snapshotTree(root);
  const boardPath = path.join(root, "board.json");
  const thread = "runtime-thread";
  const row = { ID: TICKET, Status: "review", Owner: OWNER, Repo: "X" };
  const target = { id: "target-id", handle: TARGET, status: "active", provider: "anthropic" };
  const local = { session_id: "local", agent_id: "local-id", handle: OWNER, board_path: boardPath,
    thread_id: thread, status: "active" };
  const localTarget = { ...local, session_id: "target", agent_id: target.id, handle: TARGET, thread_id: "target-thread" };
  const foreignTarget = { ...localTarget, session_id: "foreign", board_path: path.join(root, "foreign.json") };
  const closedTarget = { ...localTarget, session_id: "closed", status: "released" };
  const sessions = [foreignTarget, closedTarget, local, localTarget];
  const overrides = { GOVERNANCE_EVENT_LOG_PATH: journal, PLAN_RECORDS_DIR: path.join(root, "plans"), LEGACY_PLAN_RECORDS_DIR: null };
  const opts = { transferTo: TARGET };
  const deps = {
    fail: (msg) => { throw new Error(msg); },
    state: { ...overrides, BOARD_PATH: boardPath },
    STATUS: { TODO: "todo", DEFERRED: "deferred" },
    readBoard: () => ({ pr_index: { [TICKET]: [prUrl] } }),
    getTicketRef: () => ({ row }),
    isDoingStatus: () => false,
    canonicalizeOwnerOrFail: (owner) => owner,
    readAgentsRegistry: () => [target],
    resolveAgentIdentifier: () => ({ agent: target }),
    findLockForTicket: () => null,
    currentRuntimeThreadId: () => thread,
    readAgentSessions: () => sessions,
    detectRuntimeProvider: () => "anthropic",
    identityV2: { readEnvIdentity: () => ({ present: false }) },
    resolveHumanAdminOverride: () => ({ reason: "reviewed transfer" }),
    COORD_DIR: root,
  };
  const preview = () => testUtils.withScopedGovernanceTestContext(overrides, () => previewClaimTransfer(TICKET, opts, deps));
  const report = preview();
  const preserved = { worktree, branch: "review-branch", pr_head: head, pr_url: prUrl, workspace_owner: OWNER };
  assert.deepEqual(report.workspace.preserved_workspace, preserved);
  assert.equal(report.workspace.worktree, worktree);
  assert.equal(report.workspace.branch, "review-branch");
  assert.deepEqual(report.provenance.journal_details.preserved_workspace, preserved);
  assert.equal(report.approval.authorized, false);

  foreignTarget.session_id = "changed-foreign";
  closedTarget.session_id = "changed-closed";
  assert.equal(preview().approval.subject_sha256, report.approval.subject_sha256);
  local.session_id = "changed-local";
  const newLocalDigest = preview().approval.subject_sha256;
  assert.notEqual(newLocalDigest, report.approval.subject_sha256);
  localTarget.session_id = "changed-target";
  assert.notEqual(preview().approval.subject_sha256, newLocalDigest);
  assert.deepEqual(snapshotTree(root), before, "preview leaves the worktree and journal byte-identical");
});

test("COORD-922: claim --dry-run refuses, writing nothing, when there is no authorized transfer to preview", () => {
  workspace((ctx) => {
    const refused = (args, pattern, run = asOwner) => {
      const result = assertUnchanged(ctx, () => run(args));
      assert.equal(result.ok, false, args.join(" "));
      assert.match(result.error, pattern);
    };
    refused(["claim", TICKET, "--dry-run"], /claim --dry-run previews an owner transfer only/);
    refused(["claim", "MSRV-404", "--transfer-to", TARGET, "--human-admin-override", "x", "--dry-run"], /Unknown ticket "MSRV-404"/);
    refused(["claim", TICKET, "--transfer-to", "claudea777", "--human-admin-override", "x", "--dry-run"], /Unknown registered agent "claudea777"/);
    refused(["claim", TICKET, "--transfer-to", OWNER, "--human-admin-override", "x", "--dry-run"], /already owned by claudea0000/);
    refused(["claim", TICKET, "--transfer-to", TARGET, "--dry-run"], /claim --transfer-to requires --human-admin-override/);
    refused(["resume", TICKET, "--dry-run"], /^resume does not support --dry-run/);

    const agents = JSON.parse(fs.readFileSync(state.AGENTS_PATH, "utf8"));
    const disabled = `${JSON.stringify(agents.map((a) => (a.handle === TARGET ? { ...a, status: "disabled" } : a)), null, 2)}\n`;
    for (const file of [state.AGENTS_PATH, path.join(ctx.coordRoot, "agents.json")]) fs.writeFileSync(file, disabled);
    refused(["claim", TICKET, "--transfer-to", TARGET, "--human-admin-override", "x", "--dry-run"], /Agent claudea99 \(a99\) is not active/);
  });
  workspace(() => {
    const result = asOwner(["claim", TICKET, "--transfer-to", TARGET, "--human-admin-override", "x", "--dry-run"]);
    assert.equal(result.ok, false);
    assert.match(result.error, /MSRV-922 is todo under owner claudea0000: there is no claimed ticket to transfer/);
  }, { ticketStatus: "todo" });
});

test("COORD-922: a missing lock is previewed as recreated, and a live previous owner on another thread still refuses", () => {
  workspace((ctx) => {
    fs.renameSync(ctx.lockPath, path.join(ctx.coordRoot, "moved-lock.json"));
    const live = assertUnchanged(ctx, () => asTarget(["claim", TICKET, "--transfer-to", TARGET, "--human-admin-override", "x", "--dry-run"]));
    assert.equal(live.ok, false);
    assert.match(live.error, /active_same_owner_other_thread|another thread|live/i);

    const result = assertUnchanged(ctx, () => asOwner(["claim", TICKET, "--transfer-to", TARGET, "--human-admin-override", "x", "--dry-run"]));
    assert.equal(result.ok, true, result.error);
    const out = JSON.parse(result.stdout);
    assert.equal(out.workspace.lock, null);
    assert.equal(out.workspace.lock_recreated, true);
    assert.equal(out.provenance.journal_details.recreated_lock, true);
  });
});
