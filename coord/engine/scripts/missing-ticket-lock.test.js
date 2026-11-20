"use strict";
const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runFixtureGovernance } = require("./fixtures/fixture-governance-runner.js");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { installCanonicalEngine } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/coord-engine-schemas.js"));
const { withApprovedPacket } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/approved-reconcile.js"));

const TICKET = "TEST-001", OLD_OWNER = "codexa01", NEW_OWNER = "codexa02", BRANCH = "agent/codexa01-test-001-recovery";
const ROW = () => ({ ID: TICKET, Repo: "B", Type: "bug", Pri: "P1", Status: "doing (blocked: external evidence; preserve reason)", Owner: OLD_OWNER, Description: "Recovery regression", "Depends On": "" });

// COORD-997: building the two disposable git repositories and the canonical
// reconcile from scratch cost about 20 child spawns per test. That shared part is
// built once per file as a seed; each test copies it into a private root and
// repairs the git worktree back-pointers for that root. Nothing mutable is shared
// between tests. A fixture with a custom git environment (COORD-767) is built fresh.
function bindFixture(root, gitEnv = {}) {
  const coord = path.join(root, "coord");
  const config = process.env.COORD_PROJECT_CONFIG
    ? require(path.resolve(process.env.COORD_PROJECT_CONFIG))
    : { repos: { B: { path: "backend", integrationBranch: "dev" } } };
  const repo = path.resolve(root, config.repos.B.path);
  const integrationBranch = config.repos.B.integrationBranch || "dev";
  const fixtureEnv = { ...process.env, ...gitEnv };
  const git = (cwd, ...args) => { const r = spawnSync("git", ["-C", cwd, ...args], { env: fixtureEnv, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const write = (name, data) => { const target = path.join(coord, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, typeof data === "string" ? data : JSON.stringify(data)); };
  const read = (name) => JSON.parse(fs.readFileSync(path.join(coord,name),"utf8"));
  const renderFixtureViews = () => require(path.join(coord, "board/board.js")).renderBoardArtifacts();
  // Board validation reads the local registry; the child runtime must use the
  // same copy, including the selected matrix's repository paths and branches.
  const env = {...fixtureEnv, COORD_PROJECT_CONFIG:path.join(coord,"project.config.js"), CODEX_THREAD_ID:`recovery-${path.basename(root)}`};
  for (const key of ["NODE_TEST_CONTEXT","NODE_CHANNEL_FD","COORD_SESSION_ID","CLAUDE_SESSION_ID","CLAUDE_CODE_SESSION_ID","AGENT_THREAD_ID","COORD_AGENT_ID","COORD_AGENT_HANDLE","COORD_OWNER"]) delete env[key];
  // ADR 0031: fixture credentials authorize only the exact human-admin verbs
  // exercised here. Positive helpers retry only the refusal digest; cli/cliIn
  // remain available for reason-only and refusal assertions.
  const approval = createApprovalFixture({ allowedVerbs: ["approve", "reject", "claim --transfer-to", "integration handoff", "reconcile", "recover --human-admin-override", "agent-release"] });
  const rawCli = (...args) => approval.runCli(coord, args, {cwd:root,env,encoding:"utf8",timeout:45000});
  const signedTransfer = (run) => (...args) => {
    const isTransfer = args[0] === "claim" && args.includes("--transfer-to") && args.includes("--human-admin-override");
    if (!isTransfer) return run(...args);
    const refused = run(...args);
    const digest = /Subject digest: ([0-9a-f]{64})/.exec(`${refused.stdout || ""}\n${refused.stderr || ""}`);
    if (refused.status === 0 || !digest) return refused;
    approval.login({ verb: "claim --transfer-to", ticket: args[1], subject_sha256: digest[1] });
    return run(...args);
  };
  const signedAdmin = (run) => (...args) => {
    const isAdminOverride = args.includes("--human-admin-override") && ["recover", "agent-release"].includes(args[0]);
    if (!isAdminOverride) return run(...args);
    const refused = run(...args);
    const digest = /Subject digest: ([0-9a-f]{64})/.exec(`${refused.stdout || ""}\n${refused.stderr || ""}`);
    if (refused.status === 0 || !digest) return refused;
    const verb = args[0] === "recover" ? "recover --human-admin-override" : "agent-release";
    approval.login({ verb, ticket: args[1], subject_sha256: digest[1] });
    return run(...args);
  };
  const cli = signedTransfer(rawCli);
  const signedCli = signedAdmin(cli);
  const ok = (...args) => { const r=signedCli(...args); assert.equal(r.status,0,`${root}: ${args.join(" ")}\n${r.stdout}\n${r.stderr}`); return r; };
  // Explicit fixture authority is injected only for a command carrying the
  // override flag; reason-only calls and commands without it remain untouched.
  // COORD-1022: in-process twin of cli/ok for the characterized verbs (fixture-governance-runner.test.js).
  const cliIn = signedTransfer((...args) => runFixtureGovernance(root, args, env, approval.client()));
  const signedCliIn = signedAdmin(cliIn);
  const okIn = (...args) => { const r = signedCliIn(...args); assert.equal(r.status,0,`${root}: ${args.join(" ")}\n${r.stdout}\n${r.stderr}`); return r; };
  const reconcileFixture = (reason, spawn = false) => {
    // Explicit fixture setup can edit canonical board state directly. Keep its
    // derived projections current before using the authorized genesis/reconcile
    // path; do not weaken the production integrity preflight.
    renderFixtureViews();
    const run = spawn ? cli : cliIn;
    const args = withApprovedPacket(["reconcile", "--reason", reason,
      "--human-admin-override", "Fixture administrator approves this isolated synthetic state"], (dryArgs) => run(...dryArgs));
    let result = run(...args);
    if (result.status !== 0) {
      const text = `${result.stdout || ""}\n${result.stderr || ""}`;
      const digest = /Subject digest: ([0-9a-f]{64})/.exec(text);
      if (digest) {
        approval.login({ verb: "reconcile", ticket: "control-plane", subject_sha256: digest[1] });
        result = run(...args);
      }
    }
    assert.equal(result.status, 0, `${root}: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  // COORD-813: gov start refuses the generated --with-prompt scaffold, so a
  // fixture ticket that must reach a real start authors its prompt body through
  // the governed verb, exactly as an operator would.
  const authorPrompt = (id) => {
    const body = path.join(root, `${id}-prompt-body.md`);
    fs.writeFileSync(body, `# ${id}: fixture ticket\n\n## Acceptance Criteria\n\n- The ${id} fixture scenario reaches its governed start.\n`);
    return ok("register-prompt", id, "--body-file", body);
  };
  const worktree = path.join(repo, ".worktrees", OLD_OWNER, TICKET);
  return {root,coord,repo,ticket:TICKET,row:ROW(),branch:BRANCH,worktree,oldOwner:OLD_OWNER,newOwner:NEW_OWNER,
    git,write,read,env,cli,signedCli,ok,cliIn,signedCliIn,okIn,reconcileFixture,renderFixtureViews,authorPrompt,fixtureEnv,integrationBranch};
}

// Builds the complete shared fixture in `root` and returns the bound helpers.
function buildFixture(root, gitEnv = {}) {
  const coord = path.join(root, "coord");
  const config = process.env.COORD_PROJECT_CONFIG
    ? require(path.resolve(process.env.COORD_PROJECT_CONFIG))
    : { repos: { B: { path: "backend", integrationBranch: "dev" } } };
  for (const entry of Object.values(config.repos)) {
    assert.ok(path.resolve(root, entry.path).startsWith(root + path.sep), "fixture repositories must remain inside their temporary root");
  }
  const repo = path.resolve(root, config.repos.B.path);
  const integrationBranch = config.repos.B.integrationBranch || "dev";
  fs.mkdirSync(coord); fs.mkdirSync(repo, { recursive: true });
  const source = path.resolve(__dirname, "..", "..");
  for (const name of ["scripts", "engine", "board", "paths.js", "project.config.js", "GOVERNANCE.md", "AGENTS.md", "product", "prompts", "schemas", "docs", "agents.json"]) {
    if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(coord, name), { recursive: true });
  }
  installCanonicalEngine(coord, source);
  const write = (name, data) => { const target = path.join(coord, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, typeof data === "string" ? data : JSON.stringify(data)); };
  write("project.config.js", `module.exports=${JSON.stringify(config)};\n`);
  const fixtureEnv = { ...process.env, ...gitEnv };
  const git = (cwd, ...args) => { const r = spawnSync("git", ["-C", cwd, ...args], { env: fixtureEnv, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const ownMaintenance = (cwd) => {
    // A synchronous Git command can otherwise leave detached writers behind.
    // These settings belong only to the disposable fixture repositories.
    git(cwd, "config", "maintenance.autoDetach", "false");
    git(cwd, "config", "gc.autoDetach", "false");
  };
  git(repo, "init", "-b", integrationBranch); git(repo, "config", "user.email", "test@example.com"); git(repo, "config", "user.name", "Test");
  ownMaintenance(repo);
  fs.writeFileSync(path.join(repo, "evidence.txt"), "preserve me\n"); git(repo, "add", "evidence.txt"); git(repo, "commit", "-m", "seed");
  const worktree = path.join(repo, ".worktrees", OLD_OWNER, TICKET);
  git(repo, "worktree", "add", "-b", BRANCH, worktree);
  const row = ROW();
  write("board/tasks.json", { version: 1, metadata: { title: "Recovery", last_updated: new Date().toISOString(), canonical_references: [], plan_markdown_render_statuses: ["doing", "review"], preamble: [], plan_records_required_from_ticket: {B:"TEST-999"}, landing_index_required_from_ticket:{B:"TEST-999"}, pr_index_required_from_ticket:{B:"TEST-999"}}, sections:[{kind:"table",level:2,heading:"Recovery",separator_before:false,columns:Object.keys(row),rows:[row]}], prompt_index:{[TICKET]:"coord/prompts/recovery.md"},pr_index:{},landing_index:{},review_findings:{},followup_exceptions:{} });
  write("prompts/recovery.md", "# Recovery\n"); write("QUESTIONS.md", "# Questions\n"); write("PLAN.md", "");
  write(".runtime/agents.json", [OLD_OWNER,NEW_OWNER].map((handle,i)=>({id:`a0${i+1}`,handle,provider:"openai",status:"active",aliases:[]})));
  write(".runtime/agent_sessions.json", []);
  write(".gitignore", ".runtime/\n");
  git(coord,"init","-b","main"); git(coord,"config","user.email","test@example.com"); git(coord,"config","user.name","Test");
  ownMaintenance(coord);
  git(coord,"add","."); git(coord,"commit","-m","Seed regression fixture");
  const bound = bindFixture(root, gitEnv);
  bound.reconcileFixture("initialize isolated regression fixture");
  return bound;
}

// Per-file seed, built on first use and removed when the file's tests finish.
let SEED = null;
after(() => { if (SEED) fs.rmSync(SEED, { recursive: true, force: true }); });
function seedRoot() {
  if (!SEED) {
    SEED = fs.mkdtempSync(path.join(os.tmpdir(), "cust013-seed-"));
    buildFixture(SEED, {});
  }
  return SEED;
}

function fixture(gitEnv = {}) {
  let f;
  if (Object.keys(gitEnv).length > 0) {
    // Custom git environments are never shared: build the whole fixture afresh.
    f = buildFixture(fs.mkdtempSync(path.join(os.tmpdir(), "cust013-cli-")), gitEnv);
  } else {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cust013-cli-"));
    fs.cpSync(seedRoot(), root, { recursive: true });
    f = bindFixture(root);
    // Recreate the registered worktree back-pointers for this copy's root.
    f.git(f.repo, "worktree", "repair", f.worktree);
  }
  f.okIn("agentid", "--owner", f.newOwner);
  return f;
}

for (const target of ["coord", "repo"]) {
  test(`COORD-767: ${target} fixture maintenance finishes before its Git commit returns`, (t) => {
    const proof = fs.mkdtempSync(path.join(os.tmpdir(), "coord767-maintenance-"));
    const trace = path.join(proof, "trace.json");
    const globalConfig = path.join(proof, "global.config");
    // Local fixture policy must override ordinary inherited file configuration.
    fs.writeFileSync(globalConfig, "[gc]\n autoDetach = true\n[maintenance]\n autoDetach = true\n");
    let f, completed = false;
    try {
      f = fixture({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TRACE2_EVENT: trace });
      const repo = f[target];
      // Trigger genuine work under both legacy GC and newer geometric maintenance.
      f.git(repo, "config", "gc.auto", "1");
      f.git(repo, "config", "maintenance.geometric-repack.auto", "1");
      f.git(repo, "config", "pack.threads", "1");
      f.git(repo, "config", "pack.window", "10");
      const inputs = path.join(repo, "maintenance-input");
      fs.mkdirSync(inputs);
      const crypto = require("node:crypto");
      for (let i = 0; i < 2048; i++) {
        const data = crypto.createHash("sha256").update(String(i)).digest("hex").repeat(16) + "\n";
        fs.writeFileSync(path.join(inputs, String(i)), data);
      }
      f.git(repo, "add", "maintenance-input");
      f.git(repo, "commit", "-m", "COORD-767 real maintenance lifetime");
      // Read only complete Trace2 lines at the return boundary. No sleep or
      // wall-clock comparison can turn detached work into a passing result.
      const raw = fs.readFileSync(trace, "utf8");
      const events = raw.slice(0, raw.lastIndexOf("\n")).split("\n").filter(Boolean).map(JSON.parse);
      const commit = events.filter(e => e.event === "cmd_name" && e.name === "commit").at(-1);
      assert.ok(commit, "actual parent commit must be traced");
      const parentExit = events.findIndex(e => e.sid === commit.sid && e.event === "exit");
      assert.ok(parentExit >= 0, "parent commit must have exited");
      const children = events.filter(e => e.event === "cmd_name" && e.sid.startsWith(commit.sid + "/") &&
        ["maintenance", "gc", "repack", "pack-objects"].includes(e.name));
      assert.ok(children.some(e => e.name === "pack-objects"), "real packing must run; an idle maintenance check is insufficient");
      for (const child of children) {
        const exit = events.findIndex(e => e.sid === child.sid && e.event === "exit");
        assert.ok(exit >= 0 && exit < parentExit, `${child.name} must finish before parent commit returns`);
        assert.equal(events[exit].code, 0, `${child.name} must complete successfully`);
      }
      completed = true;
    } finally {
      if (completed) {
        fs.rmSync(f.root, { recursive: true, force: true });
        fs.rmSync(proof, { recursive: true, force: true });
      } else {
        // Preserve a failing producer's repository and trace instead of racing
        // its still-running writer merely to clean up the regression itself.
        t.diagnostic(`Git lifetime evidence retained at ${proof}; fixture ${f?.root || "setup failed"}`);
      }
    }
  });
}

// COORD-1022 named end-to-end spawn set: the env scrub (COORD-880/883) is checked against the real CLI child.
test("COORD-880/883: fixture CLI child receives no ambient session keys (named end-to-end spawn)", () => {
  const keys = ["COORD_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "AGENT_THREAD_ID", "COORD_OWNER"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = "a11-ambient0001";
  let f;
  try {
    f = fixture();
    const r = f.cli("agent-status");
    assert.doesNotMatch(r.stdout + r.stderr, /a11-ambient0001/);
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (f) fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("COORD-751: fixture authority is explicit and unapproved semantic reconciliation still refuses", () => {
  const f = fixture();
  try {
    const board = f.read("board/tasks.json");
    board.sections[0].rows[0].Description = "Explicitly seeded synthetic change";
    f.write("board/tasks.json", board);
    const before = fs.readFileSync(path.join(f.coord, "board/tasks.json"), "utf8");
    const refused = f.cli("reconcile", "--reason", "reason is not approval");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr + refused.stdout, /requires --human-admin-override/);
    assert.equal(fs.readFileSync(path.join(f.coord, "board/tasks.json"), "utf8"), before);
    f.reconcileFixture("approve the isolated synthetic change");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("CUST-013: missing-lock takeover authorizes, rolls back failures, preserves work, and creates a valid lock", () => {
 const f=fixture(); const lock=`.runtime/locks/${f.ticket}.lock`;
 try {
  assert.notEqual(f.cli("claim",f.ticket,"--transfer-to",f.newOwner).status,0);
  assert.equal(f.read("board/tasks.json").sections[0].rows[0].Owner,f.oldOwner);
  f.git(f.worktree,"checkout","--detach");
  const sessions=fs.readFileSync(path.join(f.coord,".runtime/agent_sessions.json"),"utf8");
  assert.notEqual(f.cli("claim",f.ticket,"--transfer-to",f.newOwner,"--human-admin-override","test authorization").status,0);
  assert.equal(f.read("board/tasks.json").sections[0].rows[0].Owner,f.oldOwner);
  assert.equal(fs.existsSync(path.join(f.coord,lock)),false);
  assert.equal(fs.readFileSync(path.join(f.coord,".runtime/agent_sessions.json"),"utf8"),sessions);
  f.git(f.worktree,"checkout",f.branch);
  // Force failure AFTER the owner and lock writes, in board sync. The real
  // governance transaction must restore both, including session binding.
  fs.unlinkSync(path.join(f.coord,"prompts/recovery.md"));
  const beforeFailedSync = fs.readFileSync(path.join(f.coord,".runtime/agent_sessions.json"),"utf8");
  assert.notEqual(f.cli("claim",f.ticket,"--transfer-to",f.newOwner,"--human-admin-override","test authorization").status,0);
  assert.equal(f.read("board/tasks.json").sections[0].rows[0].Owner,f.oldOwner);
  assert.equal(fs.existsSync(path.join(f.coord,lock)),false);
  assert.equal(fs.readFileSync(path.join(f.coord,".runtime/agent_sessions.json"),"utf8"),beforeFailedSync);
  f.write("prompts/recovery.md","# Recovery\n");
  f.ok("claim",f.ticket,"--transfer-to",f.newOwner,"--human-admin-override","test authorization");
  const row=f.read("board/tasks.json").sections[0].rows[0]; const actual=f.read(lock);
  assert.equal(row.Owner,f.newOwner); assert.equal(row.Status,f.row.Status);
  assert.equal(actual.owner,f.newOwner); assert.equal(actual.worktree,f.worktree); assert.equal(actual.branch,f.branch);
  assert.equal(fs.readFileSync(path.join(f.worktree,"evidence.txt"),"utf8"),"preserve me\n");
  const events=fs.readFileSync(path.join(f.coord,".runtime/governance-events.ndjson"),"utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).details.recreated_lock,true);
  assert.equal(events.at(-1).details.override_reason,"test authorization");
  f.ok("resume",f.ticket);
  f.git(f.coord,"add","."); f.git(f.coord,"commit","--allow-empty","-m","Reconcile fixture before sync"); f.ok("sync"); f.reconcileFixture("record full-scope derived fixture render", true); // Exercises the real lifecycle dependency wiring.
 } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

test("CUST-013: admin recovery restores a missing lock without impersonating or changing the blocked owner", () => {
 const f=fixture();
 try {
  assert.notEqual(f.cliIn("recover",f.ticket).status,0);
  f.okIn("recover",f.ticket,"--human-admin-override","preserve original owner");
  const actual=f.read(`.runtime/locks/${f.ticket}.lock`);
  assert.equal(actual.owner,f.oldOwner); assert.equal(actual.worktree,f.worktree);
  assert.deepEqual(f.read("board/tasks.json").sections[0].rows[0],f.row);
  const events=fs.readFileSync(path.join(f.coord,".runtime/governance-events.ndjson"),"utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).details.owner_preserved,f.oldOwner);
  assert.equal(events.at(-1).identity.owner,f.newOwner);
 } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

test("COORD-644: canonical missing-lock helper accepts one registered ticket worktree and refuses unsafe roots", () => {
  const { createTempGitRepo, runGit } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  const { verifyTicketWorktree, restoreMissingTicketLock } = require("./missing-ticket-lock.js");
  const repo = createTempGitRepo("coord644-missing-lock-validation-", { "README.md": "lock recovery fixture\n" });
  const ticketId = "LOCK-644-VALID";
  const branch = "agent/codexa00-lock-644-valid";
  const worktree = path.join(repo.repoRoot, ".worktrees", "codexa00", ticketId);
  const detachedTicket = path.join(repo.repoRoot, ".worktrees", "detached", ticketId);
  const duplicateTicket = path.join(repo.repoRoot, ".worktrees", "codexa01", ticketId);
  const unregisteredTicket = path.join(repo.repoRoot, ".worktrees", "unregistered", ticketId);
  const symlinkTicket = path.join(repo.repoRoot, ".worktrees", "symlinked", ticketId);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  runGit(repo.repoRoot, ["worktree", "add", "-b", branch, worktree, "HEAD"]);

  try {
    const context = { repoRoot: repo.repoRoot, worktree, branch };
    assert.doesNotThrow(() => verifyTicketWorktree(ticketId, context));

    const writes = [];
    assert.deepEqual(
      restoreMissingTicketLock({
        ticketId,
        row: { Repo: "X" },
        owner: "codexa00",
        session: { session_id: "session-644" },
        resolveTicketGitContext: () => context,
        writeLock: (lock) => writes.push(lock),
        findLockForTicket: () => ({ ticket: ticketId, owner: "codexa00", worktree, branch }),
      }),
      { ticket: ticketId, owner: "codexa00", worktree, branch },
    );
    assert.deepEqual(writes, [{
      ticketId,
      owner: "codexa00",
      repoCode: "X",
      branch,
      worktree,
      session: { session_id: "session-644" },
    }], "the lock is written only from the verified row-owned worktree identity");

    for (const unsafe of [
      { repoRoot: repo.repoRoot, worktree: "", branch },
      { repoRoot: "", worktree, branch },
      { repoRoot: repo.repoRoot, worktree, branch: "" },
      { repoRoot: repo.repoRoot, worktree: path.join(repo.repoRoot, "missing"), branch },
      { repoRoot: repo.repoRoot, worktree: repo.repoRoot, branch },
      { repoRoot: repo.repoRoot, worktree, branch: "feature/not-a-ticket" },
      { repoRoot: repo.repoRoot, worktree, branch: "agent/different-branch" },
    ]) {
      assert.throws(() => verifyTicketWorktree(ticketId, unsafe), /verified existing ticket worktree and branch/);
    }
    assert.throws(() => verifyTicketWorktree("OTHER-644", context), /verified existing ticket worktree and branch/,
      "a valid registered path cannot be adopted under a different ticket id");
    fs.mkdirSync(unregisteredTicket, { recursive: true });
    assert.throws(() => verifyTicketWorktree(ticketId, {
      repoRoot: repo.repoRoot,
      worktree: unregisteredTicket,
      branch,
    }), /verified existing ticket worktree and branch/,
    "an ordinary same-name directory is not a registered worktree");
    fs.mkdirSync(path.dirname(symlinkTicket), { recursive: true });
    fs.symlinkSync(worktree, symlinkTicket, "dir");
    assert.throws(() => verifyTicketWorktree(ticketId, {
      repoRoot: repo.repoRoot,
      worktree: symlinkTicket,
      branch,
    }), /verified existing ticket worktree and branch/,
    "a symlink alias cannot substitute for the registered ticket worktree path");
    assert.throws(
      () => restoreMissingTicketLock({
        ticketId,
        row: { Repo: "X" },
        owner: "codexa00",
        session: null,
        resolveTicketGitContext: () => ({ ...context, worktree: repo.repoRoot }),
        writeLock: () => assert.fail("invalid topology must not write a replacement lock"),
        findLockForTicket: () => assert.fail("invalid topology must not look up a replacement lock"),
      }),
      /verified existing ticket worktree and branch/,
    );

    runGit(repo.repoRoot, ["worktree", "add", "--detach", detachedTicket, "HEAD"]);
    assert.throws(() => verifyTicketWorktree(ticketId, {
      repoRoot: repo.repoRoot,
      worktree: detachedTicket,
      branch,
    }), /verified existing ticket worktree and branch/,
    "a registered but detached worktree cannot be adopted as an active ticket lock");

    runGit(repo.repoRoot, ["worktree", "add", "-b", "agent/codexa01-lock-644-duplicate", duplicateTicket, "HEAD"]);
    assert.throws(() => verifyTicketWorktree(ticketId, context), /verified existing ticket worktree and branch/,
      "ambiguous same-ticket registrations refuse recovery instead of choosing one by path order");
  } finally {
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
  }
});

test("missing-lock recovery refuses a registered path whose Git worktree metadata is damaged", () => {
  const { verifyTicketWorktree } = require("./missing-ticket-lock.js");
  const fixtureState = fixture();

  try {
    fs.writeFileSync(path.join(fixtureState.worktree, ".git"), "gitdir: /tmp/coord644-missing-gitdir\n", "utf8");
    assert.throws(
      () => verifyTicketWorktree(fixtureState.ticket, {
        repoRoot: fixtureState.repo,
        worktree: fixtureState.worktree,
        branch: fixtureState.branch,
      }),
      /verified existing ticket worktree and branch are required/,
      "a directory still listed by the owner repository is not recoverable after its own Git metadata stops resolving"
    );
    assert.equal(fs.existsSync(path.join(fixtureState.worktree, ".git")), true,
      "verification reports damage without rewriting the candidate worktree metadata");
  } finally {
    fs.rmSync(fixtureState.root, { recursive: true, force: true });
  }
});

for (const blocked of [false, true]) {
 test(`COORD-014: scoped mutation preserves another ticket plan (blocked: ${blocked})`, () => {
  const f=fixture();
  try {
   if (!blocked) {
    const board=f.read("board/tasks.json"); board.sections[0].rows[0].Status="doing";
    f.write("board/tasks.json",board);
    f.reconcileFixture("set fixture status before measurement");
   }
   f.okIn("recover",f.ticket,"--human-admin-override","restore fixture lock");
   f.ok("plan",f.ticket,"--seed");
   f.git(f.coord,"add","."); f.git(f.coord,"commit","--allow-empty","-m","Reconcile fixture before sync"); f.okIn("sync"); f.reconcileFixture("record full-scope derived fixture render");
   const before=fs.readFileSync(path.join(f.coord,"PLAN.md"),"utf8");
   assert.match(before,/TEST-001/);
   assert.match(before,/- Governance:/);
   f.okIn("file-ticket","TEST-002","--repo","X","--type","bug","--pri","P2","--description","Other ticket","--with-prompt");
   f.authorPrompt("TEST-002");
   const scoped=fs.readFileSync(path.join(f.coord,"PLAN.md"),"utf8");
   assert.equal(scoped,before);
   f.git(f.coord,"add","board/tasks.json","prompts"); f.git(f.coord,"commit","-m","Record fixture ticket");
   f.git(f.coord,"add","."); f.git(f.coord,"commit","--allow-empty","-m","Reconcile fixture before sync"); f.okIn("sync"); f.reconcileFixture("record full-scope derived fixture render");
   assert.equal(fs.readFileSync(path.join(f.coord,"PLAN.md"),"utf8"),scoped);
  } finally { fs.rmSync(f.root,{recursive:true,force:true}); }
 });
}

// COORD-728: Repo X recovery must verify a REGISTERED worktree like every other
// repo. It used to check only that a directory existed at the derived path and
// then INVENT the branch from a slug of the description, so `recover` succeeded
// against an ordinary unregistered directory and wrote a lock naming a branch
// that need not exist. COORD-635 already resolves X against coordRepoRoot, so
// the carve-out was never necessary.
test("COORD-728: Repo X recovery refuses an unregistered ordinary directory", () => {
  const f = fixture();
  try {
    const ticket = "TEST-010";
    const owner = f.oldOwner;
    // A Repo X ticket that is doing with no lock, whose "worktree" is a plain
    // directory at the canonical path — created, never registered with git.
    const board = f.read("board/tasks.json");
    board.sections[0].rows.push({
      ID: ticket, Repo: "X", Type: "bug", Pri: "P1", Status: "doing",
      Owner: owner, Description: "Repo X unregistered directory", "Depends On": "",
    });
    f.write("board/tasks.json", board);
    f.write("prompts/x-recovery.md", "# X\n");
    const impostor = path.join(f.coord, ".worktrees", owner, ticket);
    fs.mkdirSync(impostor, { recursive: true });
    fs.writeFileSync(path.join(impostor, "not-a-worktree.txt"), "plain directory\n");
    f.reconcileFixture("seed repo X recovery fixture");

    const result = f.signedCli("recover", ticket, "--human-admin-override", "unregistered directory must refuse");
    assert.notEqual(result.status, 0, "recovery must refuse an unregistered directory");
    assert.match(
      `${result.stdout}${result.stderr}`,
      /verified existing ticket worktree and branch are required|no canonical worktree/i
    );
    assert.equal(fs.existsSync(path.join(f.coord, `.runtime/locks/${ticket}.lock`)), false,
      "no lock may be written for an unverified workspace");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// COORD-728 complement: removing the carve-out must not break legitimate Repo X
// recovery, and the rebuilt lock must record the LIVE branch rather than a
// branch derived from the description.
test("COORD-728: a registered Repo X worktree recovers and records its live branch", () => {
  const f = fixture();
  try {
    const ticket = "TEST-011";
    const owner = f.oldOwner;
    // A branch name deliberately unlike any slug of the description, so a lock
    // recording it proves the branch was READ rather than reconstructed.
    const branch = "agent/codexa01-test-011-live-branch-not-a-slug";
    const board = f.read("board/tasks.json");
    board.sections[0].rows.push({
      ID: ticket, Repo: "X", Type: "bug", Pri: "P1", Status: "doing",
      Owner: owner, Description: "Totally unrelated description text", "Depends On": "",
    });
    f.write("board/tasks.json", board);
    f.write("prompts/x-live.md", "# X\n");
    const worktree = path.join(f.coord, ".worktrees", owner, ticket);
    f.git(f.coord, "worktree", "add", "-b", branch, worktree);
    f.reconcileFixture("seed registered repo X worktree");

    f.okIn("recover", ticket, "--human-admin-override", "registered worktree recovers");
    const lock = f.read(`.runtime/locks/${ticket}.lock`);
    assert.equal(lock.owner, owner);
    assert.equal(lock.branch, branch, "lock must record the live branch, not a derived slug");
    assert.equal(fs.realpathSync(lock.worktree), fs.realpathSync(worktree));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("COORD-644: public recovery refuses a journaled unsupported Repo value before writing a lock", () => {
  const f = fixture();
  const lockPath = path.join(f.coord, ".runtime", "locks", `${f.ticket}.lock`);
  try {
    const board = f.read("board/tasks.json");
    board.sections[0].rows[0].Repo = "Q";
    f.write("board/tasks.json", board);
    f.reconcileFixture("record intentionally corrupted repository metadata for recovery refusal test");

    const result = f.signedCliIn("recover", f.ticket, "--human-admin-override", "refuse unsupported repository metadata");
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unsupported repo code "Q"/);
    assert.equal(fs.existsSync(lockPath), false,
      "the public transaction refuses corrupt Repo metadata without synthesizing lock authority");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

// COORD-729: the shipped preservation assertion checked a COMMITTED file, which
// only proves the worktree was not deleted. What an agent actually loses is
// UNCOMMITTED work — a modified tracked file and an untracked file — and git
// will not restore either. These scenarios are the ones COORD-725 claimed to
// protect and did not exercise.
function seedUncommittedWork(f) {
  fs.appendFileSync(path.join(f.worktree, "evidence.txt"), "dirty edit\n");
  fs.writeFileSync(path.join(f.worktree, "scratch-notes.txt"), "untracked work\n");
  return {
    dirty: fs.readFileSync(path.join(f.worktree, "evidence.txt"), "utf8"),
    untracked: fs.readFileSync(path.join(f.worktree, "scratch-notes.txt"), "utf8"),
  };
}

function assertUncommittedWorkIntact(f, before, label) {
  assert.equal(fs.readFileSync(path.join(f.worktree, "evidence.txt"), "utf8"), before.dirty,
    `${label}: modified tracked bytes must survive`);
  assert.equal(fs.existsSync(path.join(f.worktree, "scratch-notes.txt")), true,
    `${label}: untracked file must survive`);
  assert.equal(fs.readFileSync(path.join(f.worktree, "scratch-notes.txt"), "utf8"), before.untracked,
    `${label}: untracked bytes must survive`);
}

test("COORD-729: dirty and untracked work survives a successful missing-lock transfer", () => {
  const f = fixture();
  try {
    const before = seedUncommittedWork(f);
    f.okIn("claim", f.ticket, "--transfer-to", f.newOwner, "--human-admin-override", "preserve uncommitted work");
    assert.equal(f.read("board/tasks.json").sections[0].rows[0].Owner, f.newOwner);
    assertUncommittedWorkIntact(f, before, "successful transfer");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("COORD-729: dirty and untracked work survives a transfer that FAILS and rolls back", () => {
  const f = fixture();
  try {
    const before = seedUncommittedWork(f);
    // Force the failure after the owner and lock writes, in board sync — the
    // same injection the shipped rollback test uses.
    fs.unlinkSync(path.join(f.coord, "prompts/recovery.md"));
    assert.notEqual(
      f.cliIn("claim", f.ticket, "--transfer-to", f.newOwner, "--human-admin-override", "rollback must not touch the workspace").status,
      0
    );
    assert.equal(f.read("board/tasks.json").sections[0].rows[0].Owner, f.oldOwner);
    assertUncommittedWorkIntact(f, before, "rolled-back transfer");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// The rebuild must not hand a live owner's workspace to a second agent: a
// heartbeat-fresh session for the current owner is a competing claim, not a
// stale one, and the transfer is exactly the "snatching" identity exists to stop.
test("COORD-729: a missing-lock transfer is refused while the owner holds a live session", () => {
  const f = fixture();
  try {
    // A competing agent is a live session for the CURRENT owner on ANOTHER
    // thread. It cannot be bound through the CLI from here (one thread binds one
    // owner), so it is injected as runtime session state the way a second
    // process would have left it: active, heartbeat-fresh, distinct thread.
    const now = new Date().toISOString();
    f.write(".runtime/agent_sessions.json", [{
      session_id: `a01-live-${Date.now()}`,
      agent_id: "a01",
      handle: f.oldOwner,
      thread_id: "competing-live-thread",
      board_path: path.join(f.coord, "board/tasks.json"),
      board_root: f.coord,
      claimed_at: now,
      last_seen_at: now,
      released_at: null,
      status: "active",
      auto_claimed: false,
    }]);
    const result = f.cliIn("claim", f.ticket, "--transfer-to", f.newOwner, "--human-admin-override", "competing live session");
    assert.notEqual(result.status, 0, "a live owner session must block the takeover");
    assert.equal(f.read("board/tasks.json").sections[0].rows[0].Owner, f.oldOwner);
    assert.equal(fs.existsSync(path.join(f.coord, `.runtime/locks/${f.ticket}.lock`)), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

function expiredRecoveryFixture() {
 const f=fixture();
 f.okIn("recover",f.ticket,"--human-admin-override","prepare existing lock for isolated recovery test");
 const lockPath=`.runtime/locks/${f.ticket}.lock`;
 const lock=f.read(lockPath);
 const previous={session_id:"expired-original",agent_id:"a01",handle:f.oldOwner,board_path:path.join(f.coord,"board/tasks.json"),
  board_root:f.coord,thread_id:"previous-thread",claimed_at:"2026-01-01T00:00:00Z",last_seen_at:"2026-01-01T00:00:00Z",released_at:"2026-01-02T00:00:00Z",status:"expired"};
 f.write(".runtime/agent_sessions.json",[previous]); lock.session_id=previous.session_id; f.write(lockPath,lock);
 fs.writeFileSync(path.join(f.worktree,"evidence.txt"),"dirty tracked bytes\n");
 fs.writeFileSync(path.join(f.worktree,"untracked.txt"),"untracked bytes\n");
 f.reconcileFixture("prepare expired session fixture");
 return {...f,lockPath,previous};
}

test("COORD-716: explicit same-owner recovery adopts an expired session and preserves dirty blocked work",()=>{
 const f=expiredRecoveryFixture();
 try {
  f.okIn("recover",f.ticket,"--owner",f.oldOwner);
  const sessions=f.read(".runtime/agent_sessions.json");
  const active=sessions.filter(s=>s.status==="active");
  assert.equal(active.length,1); assert.equal(active[0].handle,f.oldOwner);
  assert.equal(active[0].previous_session_id,f.previous.session_id);
  assert.equal(active[0].binding_sequence,1,"recovery records order on its new native thread");
  assert.deepEqual(sessions.find(s=>s.session_id===f.previous.session_id),f.previous);
  assert.equal(f.read(f.lockPath).session_id,active[0].session_id);
  assert.deepEqual(f.read("board/tasks.json").sections[0].rows[0],f.row);
  assert.equal(fs.readFileSync(path.join(f.worktree,"evidence.txt"),"utf8"),"dirty tracked bytes\n");
  assert.equal(fs.readFileSync(path.join(f.worktree,"untracked.txt"),"utf8"),"untracked bytes\n");
  const events=fs.readFileSync(path.join(f.coord,".runtime/governance-events.ndjson"),"utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).details.previous_session_id,f.previous.session_id);
  f.okIn("recover",f.ticket,"--owner",f.oldOwner);
  assert.equal(f.read(".runtime/agent_sessions.json").filter(s=>s.status==="active").length,1);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for (const kind of ["implicit-owner","foreign-owner","provider","live-owner","bound-foreign","corrupt-lock","explicit-release","ambiguous-worktree","rollback"]) {
 test(`COORD-716: ${kind} refuses without partial adoption`,()=>{
  const f=expiredRecoveryFixture();
  try {
   let owner=f.oldOwner;
   if(kind==="foreign-owner") owner=f.newOwner;
   if(kind==="provider") {const a=f.read(".runtime/agents.json");a[0].provider="anthropic";f.write(".runtime/agents.json",a);}
   if(kind==="live-owner"||kind==="bound-foreign") {
    const prior=f.previous;
    const active={...prior,session_id:"live-sibling",status:"active",released_at:null,last_seen_at:new Date().toISOString(),
     handle:kind==="live-owner"?f.oldOwner:f.newOwner,agent_id:kind==="live-owner"?"a01":"a02",
     thread_id:kind==="live-owner"?"sibling-thread":`recovery-${path.basename(f.root)}`};
    f.write(".runtime/agent_sessions.json",[prior,active]);
   }
   if(kind==="corrupt-lock") {const l=f.read(f.lockPath);l.owner=f.newOwner;f.write(f.lockPath,l);}
   if(kind==="explicit-release") f.write(".runtime/agent_sessions.json",[{...f.previous,status:"released"}]);
   if(kind==="ambiguous-worktree") f.git(f.repo,"worktree","add","-b","agent/duplicate",path.join(f.repo,"duplicate",f.ticket));
   f.reconcileFixture(`prepare ${kind} refusal fixture`);
   if(kind==="rollback") fs.unlinkSync(path.join(f.coord,"prompts/recovery.md"));
   const paths=["board/tasks.json",f.lockPath,".runtime/agent_sessions.json"];
   const before=paths.map(p=>fs.readFileSync(path.join(f.coord,p),"utf8"));
   const args=["recover",f.ticket];if(kind!=="implicit-owner")args.push("--owner",owner);
   const result=f.cli(...args);assert.notEqual(result.status,0,`${kind}: ${result.stdout}`);
   paths.forEach((p,i)=>assert.equal(fs.readFileSync(path.join(f.coord,p),"utf8"),before[i],`${kind}: changed ${p}`));
   assert.equal(fs.readFileSync(path.join(f.worktree,"evidence.txt"),"utf8"),"dirty tracked bytes\n");
   assert.equal(fs.readFileSync(path.join(f.worktree,"untracked.txt"),"utf8"),"untracked bytes\n");
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
}


test("COORD-689: release parks doing work without changing its owner lock or dirty workspace and retries safely",()=>{
 const f=fixture();
 try {
  f.okIn("claim",f.ticket,"--transfer-to",f.newOwner,"--human-admin-override","fixture handoff");
  f.ok("plan",f.ticket,"--seed");
  fs.writeFileSync(path.join(f.worktree,"evidence.txt"),"parked dirty bytes\n");
  fs.writeFileSync(path.join(f.worktree,"untracked.txt"),"parked untracked bytes\n");
  const lockPath=`.runtime/locks/${f.ticket}.lock`;
  const sessionId=f.read(lockPath).session_id;
  const paths=["board/tasks.json",lockPath,"PLAN.md",`.runtime/plans/${f.ticket}.json`];
  const before=paths.map(p=>fs.readFileSync(path.join(f.coord,p),"utf8"));
  f.okIn("agent-release",sessionId,"--reason","finished worker parking its work");
  const sessions=f.read(".runtime/agent_sessions.json");
  assert.equal(sessions.find(s=>s.session_id===sessionId).release_reason,"explicit");
  const events=fs.readFileSync(path.join(f.coord,".runtime/governance-events.ndjson"),"utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).details.reason,"finished worker parking its work");
  f.okIn("agent-release",sessionId,"--reason","retry");
  assert.deepEqual(f.read(".runtime/agent_sessions.json"),sessions);
  paths.forEach((p,i)=>assert.equal(fs.readFileSync(path.join(f.coord,p),"utf8"),before[i]));
  assert.equal(fs.readFileSync(path.join(f.worktree,"evidence.txt"),"utf8"),"parked dirty bytes\n");
  assert.equal(fs.readFileSync(path.join(f.worktree,"untracked.txt"),"utf8"),"parked untracked bytes\n");
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for (const owner of ["own", "foreign"]) for (const subject of ["id", "handle"]) {
 test(`COORD-659: ${owner} stale session release by ${subject} persists expiry and permits real start`, () => {
  const f = fixture();
  try {
   f.okIn("recover", f.ticket, "--human-admin-override", "prepare isolated canonical lock");
   f.okIn("file-ticket", "TEST-002", "--repo", "X", "--type", "bug", "--pri", "P2", "--description", "Expiry release successor", "--with-prompt");
   f.authorPrompt("TEST-002");
   const sessions = f.read(".runtime/agent_sessions.json");
   const current = sessions.find(s => s.handle === f.newOwner && s.status === "active");
   const target = owner === "own" ? current : { ...current, session_id: "expired-foreign", agent_id: "a01", handle: f.oldOwner, thread_id: "expired-foreign-thread" };
   if (owner === "foreign") sessions.push(target);
   target.last_seen_at = new Date(Date.now() - 5 * 3600000).toISOString();
   f.write(".runtime/agent_sessions.json", sessions);
   const boardBefore = fs.readFileSync(path.join(f.coord, "board/tasks.json"), "utf8");
   const lockBefore = fs.readFileSync(path.join(f.coord, `.runtime/locks/${f.ticket}.lock`), "utf8");
   const requested = subject === "id" ? target.session_id : target.handle;
   const result = f.cliIn("agent-release", requested);
   assert.equal(result.status, 0, result.stderr);
   assert.match(result.stdout, /already expired/);
   const expired = f.read(".runtime/agent_sessions.json").find(s => s.session_id === target.session_id);
   assert.equal(expired.status, "expired", "normalization must survive the successful acknowledgement");
   assert.equal(expired.release_reason, target.release_reason, "inactivity acknowledgement is not explicit parking");
   assert.equal(fs.readFileSync(path.join(f.coord, "board/tasks.json"), "utf8"), boardBefore);
   assert.equal(fs.readFileSync(path.join(f.coord, `.runtime/locks/${f.ticket}.lock`), "utf8"), lockBefore);
   f.okIn("agent-release", requested);
   const events = fs.readFileSync(path.join(f.coord, ".runtime/governance-events.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
   const acknowledgement = events.filter(e => e.command === "agent-release" && e.result === "succeeded").at(-1);
   assert.equal(acknowledgement.details.release_status, "already_expired");
   assert.deepEqual(acknowledgement.details.sessions, [target.session_id]);
   f.okIn("agent-status");
   assert.equal(f.read(".runtime/agent_sessions.json").find(s => s.session_id === target.session_id).status, "expired");
   f.okIn("start", "TEST-002");
   assert.equal(f.read(".runtime/agent_sessions.json").find(s => s.session_id === target.session_id).status, "expired");
   assert.deepEqual(f.read("board/tasks.json").sections[0].rows.find(r => r.ID === f.ticket), JSON.parse(boardBefore).sections[0].rows.find(r => r.ID === f.ticket));
   assert.equal(fs.readFileSync(path.join(f.coord, `.runtime/locks/${f.ticket}.lock`), "utf8"), lockBefore);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
 });
}

test("COORD-659: unknown release subject rolls back incidental expiry and leaves unrelated state intact", () => {
 const f = fixture();
 try {
  const sessions = f.read(".runtime/agent_sessions.json");
  sessions[0].last_seen_at = new Date(Date.now() - 5 * 3600000).toISOString();
  f.write(".runtime/agent_sessions.json", sessions);
  const before = fs.readFileSync(path.join(f.coord, ".runtime/agent_sessions.json"), "utf8");
  const board = fs.readFileSync(path.join(f.coord, "board/tasks.json"), "utf8");
  const result = f.cliIn("agent-release", "unknown-session");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No active session found/);
  assert.equal(fs.readFileSync(path.join(f.coord, ".runtime/agent_sessions.json"), "utf8"), before);
  assert.equal(fs.readFileSync(path.join(f.coord, "board/tasks.json"), "utf8"), board);
 } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const kind of ["foreign-board", "unknown-status"]) test(`COORD-659: ${kind} record cannot be acknowledged as an expired target`, () => {
 const f = fixture();
 try {
  const sessions = f.read(".runtime/agent_sessions.json");
  const target = { ...sessions[0], session_id: "non-target", agent_id: "a01", handle: f.oldOwner, thread_id: "other-thread", status: "expired" };
  if (kind === "foreign-board") target.board_path = "/other/board.json";
  else target.status = "unknown-status";
  sessions.push(target); f.write(".runtime/agent_sessions.json", sessions);
  const before = fs.readFileSync(path.join(f.coord, ".runtime/agent_sessions.json"), "utf8");
  const result = f.cliIn("agent-release", target.session_id);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No active session found/);
  assert.equal(fs.readFileSync(path.join(f.coord, ".runtime/agent_sessions.json"), "utf8"), before);
 } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("COORD-659: expired history never bypasses fresh foreign release authority", () => {
 const f = fixture();
 try {
  const sessions = f.read(".runtime/agent_sessions.json"), current = sessions[0];
  sessions.push({ ...current, session_id: "foreign-live", agent_id: "a01", handle: f.oldOwner, thread_id: "foreign-live-thread" });
  sessions.push({ ...current, session_id: "foreign-expired", agent_id: "a01", handle: f.oldOwner, thread_id: "foreign-old-thread", status: "expired" });
  f.write(".runtime/agent_sessions.json", sessions);
  const before = fs.readFileSync(path.join(f.coord, ".runtime/agent_sessions.json"), "utf8");
  const result = f.cliIn("agent-release", f.oldOwner);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Foreign session release requires/);
  assert.equal(fs.readFileSync(path.join(f.coord, ".runtime/agent_sessions.json"), "utf8"), before);
 } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("COORD-689: foreign release requires authority and removes only the finished session blocker",()=>{
 const f=fixture();
 try {
  f.okIn("recover",f.ticket,"--human-admin-override","prepare fixture lock");
  const sessions=f.read(".runtime/agent_sessions.json");
  sessions.push({...sessions[0],session_id:"foreign-worker",agent_id:"a01",handle:f.oldOwner,thread_id:"foreign-thread",auto_claimed:true});
  f.write(".runtime/agent_sessions.json",sessions);
  f.reconcileFixture("prepare live sibling fixture");
  const before=fs.readFileSync(path.join(f.coord,".runtime/agent_sessions.json"),"utf8");
  const denied=f.cliIn("agent-release","foreign-worker","--force");
  assert.notEqual(denied.status,0);assert.match(denied.stderr,/Foreign session release requires/);
  assert.equal(fs.readFileSync(path.join(f.coord,".runtime/agent_sessions.json"),"utf8"),before);
  f.okIn("file-ticket","TEST-002","--repo","X","--type","bug","--pri","P2","--description","Unrelated fixture work","--with-prompt");
  f.authorPrompt("TEST-002");
  const competing=f.cliIn("start","TEST-002");
  assert.notEqual(competing.status,0);assert.match(competing.stderr,/another heartbeat-fresh governed session/);
  f.okIn("agent-release","foreign-worker","--human-admin-override","human-confirmed finished worker");
  f.okIn("start","TEST-002");
  assert.deepEqual(f.read("board/tasks.json").sections[0].rows[0],f.row);
  assert.notEqual(f.cliIn("claim",f.ticket,"--transfer-to",f.newOwner).status,0,"release alone must not grant transfer");
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const doing of [true,false]) for(const age of ["recent","stale","unknown"]) {
 test(`COORD-689: ${age} session activity with doing=${doing} never transfers work`,()=>{
  const f=fixture();
  try {
   if(!doing) {const b=f.read("board/tasks.json");b.sections[0].rows[0].Status="todo";b.sections[0].rows[0].Owner="unassigned";f.write("board/tasks.json",b);}
   const sessions=f.read(".runtime/agent_sessions.json");
   const sibling={...sessions[0],session_id:"observed-worker",agent_id:"a01",handle:f.oldOwner,thread_id:"observed-thread",auto_claimed:true};
   if(age==="stale") sibling.last_seen_at=new Date(Date.now()-5*60*60*1000).toISOString();
   if(age==="unknown") {delete sibling.last_seen_at;delete sibling.claimed_at;}
   sessions.push(sibling);f.write(".runtime/agent_sessions.json",sessions);
   const before=fs.readFileSync(path.join(f.coord,"board/tasks.json"),"utf8");
   f.okIn("agent-status");
   assert.equal(f.read(".runtime/agent_sessions.json").find(s=>s.session_id===sibling.session_id).status,age==="stale"?"expired":"active");
   assert.equal(fs.readFileSync(path.join(f.coord,"board/tasks.json"),"utf8"),before);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
}


test("COORD-689: a failed release rolls back the session change",()=>{
 const f=fixture();
 try {
  const sessionsPath=".runtime/agent_sessions.json";
  const before=fs.readFileSync(path.join(f.coord,sessionsPath),"utf8");
  const id=f.read(sessionsPath)[0].session_id;
  const codePath=path.join(f.coord,"engine/scripts/agent-commands.js");
  const code=fs.readFileSync(codePath,"utf8");
  const marker='console.log(`Released ${targets.length} session(s) for ${subject}.`);';
  assert.ok(code.includes(marker));
  fs.writeFileSync(codePath,code.replace(marker,'throw new Error("injected failure after release write");'));
  const result=f.cli("agent-release",id);
  assert.notEqual(result.status,0);assert.match(result.stderr,/injected failure after release write/);
  assert.equal(fs.readFileSync(path.join(f.coord,sessionsPath),"utf8"),before);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

function continuationFixture() {
 const f=fixture();
 const b=f.read("board/tasks.json"); b.sections[0].rows[0].Status="done";
 f.write("board/tasks.json",b); f.reconcileFixture("prepare completed fixture");
 f.okIn("file-ticket","TEST-002","--repo","X","--type","bug","--pri","P2","--description","Continuation regression","--with-prompt");
 f.authorPrompt("TEST-002");
 const sessions=f.read(".runtime/agent_sessions.json");
 const prior=sessions.find(s=>s.handle===f.newOwner && s.status==="active");
 prior.status="released"; prior.release_reason="terminal"; prior.released_at=new Date().toISOString();
 f.write(".runtime/agent_sessions.json",sessions);
 return {...f,prior,sessions};
}
for (const reason of ["terminal", "explicit"]) for (const clock of ["backward", "equal"]) {
 test(`COORD-766: latest ${reason} binding controls continuation with ${clock} claim times`, () => {
  const f = continuationFixture();
  try {
   f.okIn("agentid", "--owner", f.oldOwner);
   const claimed = f.read(".runtime/agent_sessions.json").find(s => s.status === "active");
   f.okIn("agent-release", claimed.session_id);
   const history = f.read(".runtime/agent_sessions.json");
   const earlier = history.find(s => s.session_id === f.prior.session_id);
   const latest = history.find(s => s.session_id === claimed.session_id);
   earlier.release_reason = reason === "terminal" ? "explicit" : "terminal";
   latest.release_reason = reason;
   const now = Date.now();
   earlier.claimed_at = new Date(now + (clock === "backward" ? 2000 : 0)).toISOString();
   latest.claimed_at = new Date(now).toISOString();
   f.write(".runtime/agent_sessions.json", history);
   const before = fs.readFileSync(path.join(f.coord, ".runtime/agent_sessions.json"), "utf8");
   const result = f.cliIn("start", "TEST-002");
   if (reason === "terminal") {
    assert.equal(result.status, 0, result.stderr);
    const after = f.read(".runtime/agent_sessions.json"), active = after.find(s => s.status === "active");
    assert.equal(active.handle, f.oldOwner);
    assert.equal(active.previous_session_id, latest.session_id);
    assert.ok(active.binding_sequence > latest.binding_sequence);
    assert.deepEqual(after.filter(s => s.status !== "active"), history, "historical intervals stay intact");
   } else {
    assert.notEqual(result.status, 0, "explicit parking must not revive the earlier terminal owner");
    assert.equal(fs.readFileSync(path.join(f.coord, ".runtime/agent_sessions.json"), "utf8"), before);
   }
   assert.ok(Number.isSafeInteger(earlier.binding_sequence));
   assert.ok(latest.binding_sequence > earlier.binding_sequence, "actual claim writer records binding order");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
 });
}

for (const reason of ["terminal", "explicit"]) test(`COORD-766: ambiguous legacy ${reason} history requires explicit binding`, () => {
 const f = continuationFixture();
 try {
  f.okIn("agentid", "--owner", f.oldOwner);
  const claimed = f.read(".runtime/agent_sessions.json").find(s => s.status === "active");
  f.okIn("agent-release", claimed.session_id);
  const history = f.read(".runtime/agent_sessions.json");
  const earlier = history.find(s => s.session_id === f.prior.session_id), latest = history.find(s => s.session_id === claimed.session_id);
  earlier.release_reason = reason === "terminal" ? "explicit" : "terminal";
  latest.release_reason = reason;
  earlier.claimed_at = new Date(Date.now() + 2000).toISOString();
  latest.claimed_at = new Date().toISOString();
  for (const session of history) delete session.binding_sequence;
  f.write(".runtime/agent_sessions.json", history);
  const before = fs.readFileSync(path.join(f.coord, ".runtime/agent_sessions.json"), "utf8");
  assert.notEqual(f.cliIn("start", "TEST-002").status, 0, "ambiguous history is not authority");
  assert.equal(fs.readFileSync(path.join(f.coord, ".runtime/agent_sessions.json"), "utf8"), before);
  f.okIn("agentid", "--owner", f.oldOwner);
  f.okIn("start", "TEST-002");
  assert.ok(f.read(".runtime/agent_sessions.json").find(s => s.status === "active").binding_sequence > 0);
 } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const mode of ["terminal","expired"]) test(`COORD-724: ${mode} native thread continues into a real start with a new interval`,()=>{
 const f=continuationFixture();
 try {
  if(mode==="expired") {f.prior.status="expired"; delete f.prior.release_reason; f.prior.last_seen_at=new Date(Date.now()-5*3600000).toISOString(); f.write(".runtime/agent_sessions.json",f.sessions);}
  const prior=JSON.parse(JSON.stringify(f.prior));
  f.okIn("agent-status");
  assert.equal(f.read(".runtime/agent_sessions.json").filter(s=>s.status==="active").length,0);
  f.okIn("start","TEST-002");
  const after=f.read(".runtime/agent_sessions.json"), active=after.find(s=>s.status==="active");
  assert.equal(active.handle,f.newOwner); assert.equal(active.previous_session_id,prior.session_id);
  assert.notEqual(active.session_id,prior.session_id); assert.equal(active.release_reason,undefined);
  assert.deepEqual(after.find(s=>s.session_id===prior.session_id),prior);
  f.okIn("start","TEST-002");
  assert.equal(f.read(".runtime/agent_sessions.json").length,after.length);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
for(const mode of ["explicit","foreign-thread","foreign-board","provider","competing","unknown-reason","corrupt-id","fallback","rollback"]) test(`COORD-724: continuation refuses ${mode} without changing session intervals`,()=>{
 const f=continuationFixture();
 try {
  if(mode==="explicit") f.prior.release_reason="explicit";
  if(mode==="fallback") {delete f.env.CODEX_THREAD_ID; f.write(".session-thread-openai",{provider:"openai",thread_id:f.prior.thread_id,created_at:new Date().toISOString()});}
  if(mode==="foreign-thread") f.prior.thread_id="foreign-thread";
  if(mode==="foreign-board") f.prior.board_path="/foreign/board.json";
  if(mode==="provider") {const a=f.read(".runtime/agents.json"); a.find(a=>a.handle===f.newOwner).provider="anthropic"; f.write(".runtime/agents.json",a);}
  if(mode==="competing") f.sessions.push({...f.prior,session_id:"competing",thread_id:"competing-thread",status:"active",released_at:null});
  if(mode==="unknown-reason") delete f.prior.release_reason;
  if(mode==="corrupt-id") f.prior.agent_id="wrong-id";
  f.write(".runtime/agent_sessions.json",f.sessions);
  if(mode==="rollback") {const b=f.read("board/tasks.json"); fs.unlinkSync(path.resolve(f.root,b.prompt_index["TEST-002"]));}
  const before=fs.readFileSync(path.join(f.coord,".runtime/agent_sessions.json"),"utf8");
  const board=fs.readFileSync(path.join(f.coord,"board/tasks.json"),"utf8");
  const r=f.cliIn("start","TEST-002"); assert.notEqual(r.status,0,r.stdout);
  assert.equal(fs.readFileSync(path.join(f.coord,".runtime/agent_sessions.json"),"utf8"),before);
  assert.equal(fs.readFileSync(path.join(f.coord,"board/tasks.json"),"utf8"),board);
  if(mode==="explicit") {assert.match(r.stderr,/agentid --owner/); f.okIn("agentid","--owner",f.newOwner); f.okIn("start","TEST-002");}
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const status of ['doing','doing (blocked: waiting on independent proof)','review','done']) test(`COORD-558: real resume and recover status contract for ${status}`,()=>{
 const f=fixture();
 try {
  f.ok('claim',f.ticket,'--transfer-to',f.newOwner,'--human-admin-override','fixture handoff');
  f.ok('plan',f.ticket,'--seed');
  const board=f.read('board/tasks.json');board.sections[0].rows[0].Status=status;f.write('board/tasks.json',board);
  f.reconcileFixture('prepare status matrix fixture');
  fs.writeFileSync(path.join(f.worktree,'evidence.txt'),'dirty status evidence\n');
  fs.writeFileSync(path.join(f.worktree,'untracked.txt'),'untracked status evidence\n');
  const plan=f.read(`.runtime/plans/${f.ticket}.json`);
  if(status==='done') {assert.notEqual(f.cli('resume',f.ticket).status,0);return;}
  f.ok('resume',f.ticket);f.ok('recover',f.ticket);
  assert.equal(f.read('board/tasks.json').sections[0].rows[0].Status,status);
  assert.equal(f.read('board/tasks.json').sections[0].rows[0].Owner,f.newOwner);
  assert.deepEqual(f.read(`.runtime/plans/${f.ticket}.json`),plan);
  assert.equal(fs.readFileSync(path.join(f.worktree,'evidence.txt'),'utf8'),'dirty status evidence\n');
  assert.equal(fs.readFileSync(path.join(f.worktree,'untracked.txt'),'utf8'),'untracked status evidence\n');
  if(status.startsWith('doing')) {
   f.ok('heartbeat',f.ticket);
   const lock=f.read(`.runtime/locks/${f.ticket}.lock`); assert.equal(lock.status,'doing');assert.equal(lock.worktree,f.worktree);assert.equal(lock.branch,f.branch);
   if(status!=='doing') for(const args of [['commit',f.ticket,'--message','must refuse','--all'],['submit',f.ticket,'--pr','local-review (no PR)'],['move-review',f.ticket]]) assert.notEqual(f.cli(...args).status,0,`${args[0]} must not authorize blocked work`);
  }
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('COORD-558: with the owner WIP cap retired (ADR 0021) an unrelated doing pair is admitted, the owner-doing warning names it, and only a recorded closeout-blocker relation suppresses it',()=>{
 const { buildOwnerDoingDoctorWarnings } = require("./doctor-report.js"); // COORD-963: the owner-doing doctor warning
 const f=fixture();
 try {
  f.ok('claim',f.ticket,'--transfer-to',f.newOwner,'--human-admin-override','fixture handoff');
  f.ok('file-ticket','TEST-002','--repo','X','--type','bug','--pri','P2','--description','Closeout prerequisite','--with-prompt');
  f.authorPrompt("TEST-002");
  // COORD-963: the owner WIP cap is retired, so start admits the unrelated pair without a relation.
  f.ok('start','TEST-002');
  const rowOf=(board,id)=>board.sections.flatMap(s=>s.rows||[]).find(r=>r.ID===id);
  const started=rowOf(f.read('board/tasks.json'),'TEST-002');
  assert.match(started.Status,/^doing/);
  assert.equal(started.Owner,f.newOwner);
  // The owner-doing warning names the unrelated pair (TEST-001 and TEST-002, both held by newOwner).
  const pairWarnings=(board)=>buildOwnerDoingDoctorWarnings({board}).filter(w=>w.includes(f.ticket)&&w.includes('TEST-002'));
  const warned=pairWarnings(f.read('board/tasks.json'));
  assert.equal(warned.length,1,'the owner-doing warning must name the unrelated pair');
  assert.match(warned[0],new RegExp(`${f.newOwner} holds unrelated doing tickets`));
  // Only a recorded closeout-blocker relation suppresses that warning.
  f.ok('set-followup-relation','TEST-002','--depends-on',f.ticket,'--relation','closeout-blocker');
  assert.deepEqual(pairWarnings(f.read('board/tasks.json')),[],'a recorded closeout-blocker relation must suppress the owner-doing warning');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

// COORD-1015: git lists canonical worktree paths. A registered ticket worktree reached
// through a symlinked parent is the same worktree, so lock recovery must accept it.
test("COORD-1015 verifyTicketWorktree: a registered ticket worktree reached through a symlinked parent is valid", () => {
  const { createTempGitRepo, runGit } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  const { verifyTicketWorktree } = require("./missing-ticket-lock.js");
  const repo = createTempGitRepo("coord1015-missing-lock-", { "README.md": "lock recovery fixture\n" });
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "coord1015-link-"));
  const ticketId = "LOCK-1015-LINK";
  const branch = "agent/codexa00-lock-1015-link";
  const worktree = path.join(repo.repoRoot, ".worktrees", "codexa00", ticketId);
  try {
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    runGit(repo.repoRoot, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
    fs.symlinkSync(repo.repoRoot, path.join(linkParent, "alias"), "dir");
    const viaLink = path.join(linkParent, "alias", ".worktrees", "codexa00", ticketId);
    assert.doesNotThrow(() => verifyTicketWorktree(ticketId, { repoRoot: repo.repoRoot, worktree: viaLink, branch }));
  } finally {
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    if (repo.remoteRoot) fs.rmSync(repo.remoteRoot, { recursive: true, force: true });
  }
});
