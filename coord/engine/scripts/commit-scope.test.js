"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { declaredScope, checkPaths, prepareCommitScope } = require("./commit-scope.js");
const createTicketCommands = require("./ticket-commands.js");

function fixture(t, seed = true, commandDeps = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord720-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gitTry = (cwd, args, options = {}) => spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", ...options,
    env: { ...process.env, ...options.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
  });
  const git = (args) => {
    const result = gitTry(root, args);
    assert.equal(result.status, 0, String(result.stderr));
    return result.stdout;
  };
  const write = (name, text = "changed\n") => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  };
  git(["init", "-q", "-b", "main"]);
  if (seed) {
    write("inside.txt", "before\n"); write("outside.txt", "before\n");
    git(["add", "-A"]); git(["commit", "-qm", "initial"]);
  }
  const snapshot = () => ({
    head: gitTry(root, ["rev-parse", "--verify", "HEAD"]).stdout,
    index: fs.existsSync(path.join(root, ".git/index")) ? fs.readFileSync(path.join(root, ".git/index")) : null,
    commits: git(["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"]).split("\n").filter((v) => v === "commit").length,
  });
  const prepare = (options = {}) => prepareCommitScope({ gitTry, worktree: root,
    record: { intended_files: ["inside.txt"] }, layout: { workspaceRoot: root }, repoRoot: root,
    files: [], ...options });
  // Real production commit factory and real Git; board/identity/transaction are
  // explicitly synthetic seams. A separate public CLI test covers those seams.
  let mutation;
  const command = createTicketCommands({ STATUS: { DOING: "doing" }, inferTicketStatus: () => "doing",
    withGovernanceMutation: (item, run) => { mutation = item; return run(); },
    readBoard: () => ({}), getTicketRef: () => ({ row: { Status: "doing", Repo: "FIXTURE" } }),
    isRepoBackedCode: () => true, findLockForTicket: () => ({ worktree: root, branch: "main" }),
    assertTicketMutationOwnership: () => ({ fixture: true }), toArray: (value) => value || [],
    readPlanRecord: () => ({ intended_files: ["inside.txt"] }),
    // The registered repository root belongs to the source fixture contract;
    // lock.worktree above is the only Git mutation target.
    resolveTicketGitContext: () => ({ repoRoot: path.resolve(__dirname, "../../..") }),
    gitTry, runGit: (_root, args) => git(args), gitOutput: (_root, args) => git(args),
    refreshLockHead: () => {}, fail: (message) => { throw new Error(message); },
    ...commandDeps,
  });
  return { root, git, gitTry, write, snapshot, prepare, command, mutation: () => mutation };
}

test("COORD-720: commit admission refuses invalid ticket and lock state before any Git effect", () => {
  const cases = [
    { ticket: null, pattern: /requires <ticket-id>/ },
    { options: {}, pattern: /requires --message/ },
    { deps: { getTicketRef: () => null }, pattern: /Unknown ticket/ },
    { row: { Status: "review", Repo: "F" }, pattern: /must be doing/ },
    { row: { Status: "doing", Repo: "UNKNOWN" }, deps: { isRepoBackedCode: () => false }, pattern: /only supported for governed git worktrees/ },
    { deps: { findLockForTicket: () => null }, pattern: /no active lock/ },
    { deps: { findLockForTicket: () => ({ worktree: "" }) }, pattern: /missing worktree/ },
  ];
  for (const scenario of cases) {
    let effects = 0;
    const commands = createTicketCommands({
      STATUS: { DOING: "doing" }, inferTicketStatus: () => "doing",
      withGovernanceMutation: (_mutation, run) => run(), readBoard: () => ({}),
      getTicketRef: () => ({ row: scenario.row || { Status: "doing", Repo: "F" } }),
      isRepoBackedCode: () => true, findLockForTicket: () => ({ worktree: "" }),
      assertTicketMutationOwnership: () => ({ fixture: true }),
      runGit: () => { effects++; }, gitTry: () => { effects++; },
      fail: (message) => { throw new Error(message); }, ...scenario.deps,
    });
    assert.throws(() => commands.commitTicket(Object.hasOwn(scenario, "ticket") ? scenario.ticket : "FIX-1",
      scenario.options || { message: "must refuse" }), scenario.pattern);
    assert.equal(effects, 0, "admission refusal cannot stage or commit");
  }
});

test("COORD-720: commit reports a missing optional branch without losing committed scope evidence", (t) => {
  let f;
  f = fixture(t, true, {
    findLockForTicket: () => ({ worktree: f.root }),
    getTicketRef: () => ({ row: { Status: "doing", Repo: "X" } }),
    isRepoBackedCode: () => false,
  });
  f.write("inside.txt", "committed without an optional lock branch label\n");
  const log = console.log;
  let result;
  console.log = (value) => { result = JSON.parse(value); };
  try { f.command.commitTicket("FIX-1", { message: "explicit scope", files: ["inside.txt"] }); }
  finally { console.log = log; }
  assert.equal(result.branch, null);
  assert.deepEqual(result.staged_files, ["inside.txt"]);
  assert.equal(result.head, f.git(["rev-parse", "HEAD"]).trim());
  assert.equal(f.mutation().details.source_commit_sha, result.head);
});

test("COORD-720: no-Git control-plane topology refuses before touching an index", () => {
  // Override this factory's existing module collaborator only during creation;
  // no live topology or Git files are changed, and the captured dependency is
  // restored before exercising the command.
  const topology = require("./control-plane-paths.js");
  const original = topology.defaultControlPlaneLayout;
  let effects = 0;
  let command;
  try {
    topology.defaultControlPlaneLayout = () => ({ coordRepoRoot: null, coordDir: "/fixture/coord", topology: "none" });
    command = createTicketCommands({
      STATUS: { DOING: "doing" }, inferTicketStatus: () => "doing",
      withGovernanceMutation: (_mutation, run) => run(), readBoard: () => ({}),
      getTicketRef: () => ({ row: { Status: "doing", Repo: "X" } }),
      isRepoBackedCode: () => false,
      runGit: () => { effects++; }, gitTry: () => { effects++; },
      fail: (message) => { throw new Error(message); },
    });
  } finally { topology.defaultControlPlaneLayout = original; }
  assert.throws(() => command.commitTicket("FIX-1", { message: "must refuse" }),
    /requires a control-plane Git repository/);
  assert.equal(effects, 0);
});

test("COORD-720: explicit registered-root mapping has one interpretation", () => {
  const record = (files) => ({ intended_files: files });
  assert.deepEqual(declaredScope(record(["frontend/apps/a", "local/", "frontend/apps/a"]),
    { workspaceRoot: "/project", repoRoot: "/project/frontend" }), ["apps/a", "local"]);
  assert.deepEqual(declaredScope(record(["coord/scripts/a"]),
    { workspaceRoot: "/project", repoRoot: "/project/coord" }), ["scripts/a"]);
  assert.deepEqual(declaredScope(record(["coord/scripts/a"]),
    { workspaceRoot: "/project", repoRoot: "/project" }), ["coord/scripts/a"]);
  for (const files of [null, [], ["TODO: files"], [".worktrees/owner/T/*"], [7], ["../x"], ["/x"], ["a//b"], ["a/./b"], ["C:/x"], ["a\0b"], [""]]) {
    assert.throws(() => declaredScope(record(files), { workspaceRoot: "/project", repoRoot: "/project" }));
  }
  assert.throws(() => declaredScope(record(["a"]), { workspaceRoot: "/project", repoRoot: "/other" }), /outside/);
  assert.throws(() => declaredScope(record(["a"]), { workspaceRoot: "/project/child", repoRoot: "/project" }), /outside/);
  assert.throws(() => checkPaths(["src-sibling/a"], ["src"], []), /src-sibling/);
  assert.deepEqual(checkPaths(["src/a"], ["src"], []), []);
  assert.throws(() => checkPaths(["src/a"], ["src"], ["src/a"]), /Unmatched/);
  assert.throws(() => checkPaths(["src/a"], ["src"], [7]), /Invalid declared/);
  assert.throws(() => declaredScope(null, { workspaceRoot: "/project", repoRoot: "/project" }), /intended_files/);
  assert.deepEqual(checkPaths([" extra ", "a\\b"], ["inside"], ["a\\b", " extra ", "a\\b"]), [" extra ", "a\\b"]);
});

for (const mode of ["omitted", "all", "explicit"]) {
  test(`COORD-720: ${mode} real command refuses outsiders without a commit object or index change`, (t) => {
    const f = fixture(t);
    f.write("inside.txt"); f.write("outside.txt"); f.write("two\nlines.txt");
    f.git(["add", "--", "outside.txt", "two\nlines.txt"]);
    const before = f.snapshot();
    const options = mode === "all" ? { all: true } : mode === "explicit" ? { files: ["inside.txt"] } : {};
    assert.throws(() => f.command.commitTicket("FIX-1", { message: "must refuse", ...options }), (error) => {
      assert.ok(error.message.includes(JSON.stringify("outside.txt")));
      assert.ok(error.message.includes(JSON.stringify("two\nlines.txt")));
      return true;
    });
    assert.deepEqual(f.snapshot(), before);
    assert.equal(fs.readFileSync(path.join(f.root, "inside.txt"), "utf8"), "changed\n");
  });
}

test("COORD-720: actual command commits only with exact acknowledged exceptions and captures journal details", (t) => {
  const f = fixture(t); f.write("inside.txt"); f.write("outside.txt");
  const before = f.snapshot();
  for (const ack of [["not-present"], ["outside.txt", "not-present"]]) {
    assert.throws(() => f.command.commitTicket("FIX-1", { message: "bad ack", ackOutsideScope: ack }), /scope refused/);
    assert.deepEqual(f.snapshot(), before);
  }
  f.command.commitTicket("FIX-1", { message: "explicit scope exception", ackOutsideScope: ["outside.txt"] });
  assert.equal(f.snapshot().commits, before.commits + 1);
  assert.deepEqual(f.git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim().split("\n"), ["inside.txt", "outside.txt"]);
  assert.equal(f.mutation().forceLog, true);
  assert.deepEqual(f.mutation().details, { declared_files: ["inside.txt"], staged_files: ["inside.txt", "outside.txt"], acknowledged_outside_scope: ["outside.txt"], source_commit_sha: f.git(["rev-parse", "HEAD"]).trim() });
});

test("COORD-720: in-scope commit retains normal successful hooks and hook failure", (t) => {
  const f = fixture(t); f.write("inside.txt");
  const hook = path.join(f.root, ".git/hooks/pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const before = f.snapshot();
  assert.throws(() => f.command.commitTicket("FIX-1", { message: "hook failure", files: ["inside.txt"] }));
  assert.equal(f.snapshot().head, before.head); assert.equal(f.snapshot().commits, before.commits);
  fs.writeFileSync(hook, "#!/bin/sh\necho ran > .git-hook-witness\n");
  f.command.commitTicket("FIX-1", { message: "hook success", files: ["inside.txt"] });
  assert.equal(fs.readFileSync(path.join(f.root, ".git-hook-witness"), "utf8"), "ran\n");
  assert.deepEqual(f.mutation().details.staged_files, ["inside.txt"]);
});

test("COORD-720: preflight sees deletes and both rename endpoints", (t) => {
  const f = fixture(t);
  fs.renameSync(path.join(f.root, "outside.txt"), path.join(f.root, "inside-new.txt"));
  const before = f.snapshot();
  assert.throws(() => f.prepare({ record: { intended_files: ["inside-new.txt"] } }), /outside.txt/);
  assert.deepEqual(f.snapshot(), before);
  const p = f.prepare({ record: { intended_files: ["inside-new.txt", "outside.txt"] } });
  p.assertUnchanged(); f.git(p.addArgs);
  assert.deepEqual(p.validateStaged().staged_files, ["inside-new.txt", "outside.txt"]);
});

test("COORD-720: Git pathspec expansion and literal unusual paths", (t) => {
  const f = fixture(t);
  for (const name of ["space name", "two\nlines", "back\\slash", "-dash", " white "]) f.write(name);
  const names = ["space name", "two\nlines", "back\\slash", "-dash", " white "];
  const before = f.snapshot();
  assert.throws(() => f.prepare({ files: [":(glob)*"], record: { intended_files: ["space name"] } }), /scope refused/);
  assert.deepEqual(f.snapshot(), before);
  const p = f.prepare({ record: { intended_files: names } }); p.assertUnchanged(); f.git(p.addArgs);
  assert.deepEqual(p.validateStaged().staged_files.sort(), names.sort());
});

test("COORD-720: unborn repository and empty commit refusal", (t) => {
  const f = fixture(t, false);
  assert.throws(() => f.prepare(), /no staged changes/);
  f.write("inside.txt");
  const p = f.prepare(); p.assertUnchanged(); f.git(p.addArgs);
  assert.deepEqual(p.validateStaged().staged_files, ["inside.txt"]);
  f.git(["commit", "-qm", "first"]);
  assert.equal(f.snapshot().commits, 1);
  assert.throws(() => f.prepare(), /no staged changes/);
});

test("COORD-720: stale real index and HEAD refuse without overwriting another writer", (t) => {
  const f = fixture(t); f.write("inside.txt"); f.write("outside.txt");
  const p = f.prepare({ files: ["inside.txt"] });
  f.git(["add", "--", "outside.txt"]); const other = f.snapshot();
  assert.throws(() => p.assertUnchanged(), /became stale/); assert.deepEqual(f.snapshot(), other);
  assert.throws(() => p.validateStaged(), /scope refused/); assert.deepEqual(f.snapshot(), other);
  f.git(["commit", "-qm", "another writer"]);
  assert.throws(() => p.assertUnchanged(), /became stale/);
  assert.throws(() => p.validateStaged(), /HEAD changed/);
});

test("COORD-720: changed staged set after preflight refuses even inside declared scope", (t) => {
  const f = fixture(t); f.write("inside.txt");
  const p = f.prepare({ record: { intended_files: ["inside.txt", "later.txt"] } });
  p.assertUnchanged(); f.git(p.addArgs); f.write("later.txt"); f.git(["add", "--", "later.txt"]);
  const other = f.snapshot(); assert.throws(() => p.validateStaged(), /path set changed/); assert.deepEqual(f.snapshot(), other);
});

test("COORD-720: invalid UTF-8 names cannot be conflated in journal paths", (t) => {
  if (process.platform === "win32") { t.skip("Windows filenames do not expose arbitrary POSIX byte names"); return; }
  const f = fixture(t); const name = Buffer.concat([Buffer.from(`${f.root}/`), Buffer.from([0xff])]);
  fs.writeFileSync(name, "raw bytes\n"); const before = f.snapshot();
  assert.throws(() => f.prepare(), /encoded data|encoding/i); assert.deepEqual(f.snapshot(), before);
});

test("COORD-720: ambient Git target overrides are refused before staging", (t) => {
  const f = fixture(t); f.write("inside.txt"); const before = f.snapshot();
  for (const key of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"]) {
    const previous = process.env[key];
    try {
      process.env[key] = path.join(f.root, "unrelated-target");
      assert.throws(() => f.prepare(), new RegExp(key));
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  }
  assert.deepEqual(f.snapshot(), before);
});

test("COORD-720: a leading Unicode BOM is part of the filename, not a text encoding marker", (t) => {
  const f = fixture(t, false); const name = "\uFEFFfoo"; f.write(name);
  const before = f.snapshot(); const record = { intended_files: ["foo"] };
  assert.throws(() => f.prepare({ record }), /scope refused/);
  assert.deepEqual(f.snapshot(), before);
  const p = f.prepare({ record, acknowledgements: [name] }); p.assertUnchanged(); f.git(p.addArgs);
  assert.deepEqual(p.validateStaged(), { declared_files: ["foo"], staged_files: [name], acknowledged_outside_scope: [name] });
});

test("COORD-720: Git and filesystem failures cannot turn into scope admission", (t) => {
  const f = fixture(t); f.write("inside.txt"); const before = f.snapshot();
  assert.throws(() => f.prepare({ files: ["missing-path"] }), /git add failed/);
  // Explicit subprocess failure injection: unavailable executable and a child
  // killed without stderr. These are failure handling, not path-policy mocks.
  for (const result of [{ status: null, error: new Error("spawn unavailable") }, { status: 1 }]) {
    assert.throws(() => f.prepare({ gitTry: () => result }), /Commit preflight git rev-parse failed/);
  }
  assert.deepEqual(f.snapshot(), before);
  const index = path.join(f.root, ".git/index");
  fs.unlinkSync(index); fs.mkdirSync(index);
  try { assert.throws(() => f.prepare(), /EISDIR/); }
  finally { fs.rmdirSync(index); fs.writeFileSync(index, before.index); }
  assert.deepEqual(f.snapshot(), before);
});

test("COORD-720: disappearance or creation of the index invalidates preflight", (t) => {
  const f = fixture(t); f.write("inside.txt"); const p = f.prepare();
  fs.unlinkSync(path.join(f.root, ".git/index"));
  assert.throws(() => p.assertUnchanged(), /became stale/);
  assert.equal(fs.existsSync(path.join(f.root, ".git/index")), false);
  const unborn = fixture(t, false); unborn.write("inside.txt");
  const q = unborn.prepare(); unborn.git(["add", "--", "inside.txt"]);
  assert.throws(() => q.assertUnchanged(), /became stale/);
});
