"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const lib = require("./hook-lib.js");

function tmpRoot(t = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-hook-lib-"));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeConfig(root, repos) {
  fs.mkdirSync(path.join(root, "coord"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "coord", "project.config.js"),
    `module.exports = ${JSON.stringify({ repos })};\n`
  );
}

test("extractTicketId finds the first ticket id, like the old grep -oP hook", () => {
  assert.equal(lib.extractTicketId("coord/scripts/gov commit COORD-476 --message x"), "COORD-476");
  assert.equal(lib.extractTicketId("gov land FE-12 then COORD-9"), "FE-12");
  assert.equal(lib.extractTicketId("no ticket here"), null);
  assert.equal(lib.extractTicketId(""), null);
});

test("extractWorktreePath supports worktree= and JSON forms", () => {
  assert.equal(lib.extractWorktreePath("... worktree=/tmp/wt/COORD-1 head=abc"), "/tmp/wt/COORD-1");
  assert.equal(lib.extractWorktreePath('{ "worktree": "/x/y z" }'), "/x/y z");
  assert.equal(lib.extractWorktreePath("nothing"), null);
});

test("gov command matchers", () => {
  assert.equal(lib.isGovCommitCommand("coord/scripts/gov commit COORD-1 -m x"), true);
  assert.equal(lib.isGovCommitCommand("node coord/scripts/governance.js commit COORD-1"), true);
  assert.equal(lib.isGovCommitCommand("git commit -m x"), false);
  assert.equal(lib.isGovLandCommand("coord/scripts/gov land COORD-1"), true);
  assert.equal(lib.isGovLandCommand("coord/scripts/agent land COORD-1"), true);
  assert.equal(lib.isGovLandCommand("echo landing"), false);
  assert.equal(lib.outputReportsMerged('{"status": "merged"}'), true);
  assert.equal(lib.outputReportsMerged('{"status": "open"}'), false);
});

test("protectedBranchMutation matches configured branches, not literals", () => {
  const branches = ["main", "release-2026"];
  assert.equal(lib.protectedBranchMutation("git push origin main", branches), "main");
  assert.equal(lib.protectedBranchMutation("git -C backend push origin release-2026", branches), "release-2026");
  assert.equal(lib.protectedBranchMutation("git merge main", branches), "main");
  assert.equal(lib.protectedBranchMutation("git cherry-pick abc && git push origin main", branches), "main");
  assert.equal(lib.protectedBranchMutation("git push origin HEAD:main", branches), "main");
  // non-mutating or unrelated commands pass
  assert.equal(lib.protectedBranchMutation("git checkout main", branches), null);
  assert.equal(lib.protectedBranchMutation("git push origin feature/thing", branches), null);
  assert.equal(lib.protectedBranchMutation("git merge agent/claudea11-coord-476-fallback", branches), null);
  assert.equal(lib.protectedBranchMutation("ls -la", branches), null);
  // longer branch names that merely contain a protected name pass
  assert.equal(lib.protectedBranchMutation("git push origin main-menu", branches), null);
  assert.equal(lib.protectedBranchMutation("git push origin mainline", branches), null);
});

test("protectedBranchMutation is driven by config: dev only blocks when configured", () => {
  assert.equal(lib.protectedBranchMutation("git push origin dev", ["main"]), null);
  assert.equal(lib.protectedBranchMutation("git push origin dev", ["dev"]), "dev");
});

// --- COORD-664: classification by what the command DOES ---------------------

test("parseGitInvocations reads the real subcommand, and only from command position", () => {
  assert.deepEqual(
    lib.parseGitInvocations("git merge --no-ff abc123").map((i) => i.subcommand),
    ["merge"]
  );
  // global options do not hide the subcommand
  assert.deepEqual(
    lib.parseGitInvocations("git -C api -c user.name=x push origin main").map((i) => i.subcommand),
    ["push"]
  );
  // merge-base is NOT merge: an ancestry query is a different verb
  assert.deepEqual(
    lib.parseGitInvocations("git merge-base --is-ancestor abc main").map((i) => i.subcommand),
    ["merge-base"]
  );
  // git named inside a quoted ARGUMENT of another program is data, not a command
  assert.deepEqual(lib.parseGitInvocations('gov file-ticket --description "git merge main"'), []);
  // ...but a shell wrapper really does execute its argument
  assert.deepEqual(
    lib.parseGitInvocations('sh -c "git merge abc123"').map((i) => i.subcommand),
    ["merge"]
  );
  // every segment of a compound command is inspected
  assert.deepEqual(
    lib.parseGitInvocations("git status && git cherry-pick abc | tee log").map((i) => i.subcommand),
    ["status", "cherry-pick"]
  );
});

test("COORD-1052: hook parser keeps unresolved shell syntax and Git aliases fail-closed", () => {
  assert.equal(lib.trustedEngineRoot(path.join("/workspace", "coord", "engine", "scripts", "hooks")), "/workspace");
  assert.throws(
    () => lib.trustedEngineRoot(path.join("/workspace", "coord", "scripts", "hooks")),
    /not installed at coord\/engine\/scripts\/hooks/
  );

  // An unclosed substitution is parsed through end-of-input so its ref-moving
  // command remains visible to the guard.
  assert.deepEqual(
    lib.parseGitInvocations("echo $(git push origin main").map((invocation) => invocation.subcommand),
    ["push"]
  );
  assert.deepEqual(
    lib.parseGitInvocations("echo `git merge main").map((invocation) => invocation.subcommand),
    ["merge"]
  );

  // The escaped quotes stay in one double-quoted argument; the semicolon after
  // it still starts a separate shell command.
  assert.deepEqual(
    lib.lexShellSegments('echo "git merge \\"main\\""; git status'),
    [["echo", 'git merge "main"'], ["git", "status"]]
  );

  // A literal command word with a parameter marker cannot resolve as a Git subcommand.
  const literal = lib.parseGitInvocations("git -c 'alias.inspect=$word' inspect")[0];
  assert.equal(literal.unresolved, "subcommand");
  const empty = lib.parseGitInvocations("git -c alias.deploy= deploy")[0];
  assert.equal(empty.unresolved, "alias");
  assert.match(empty.error, /is empty/);

  const deep = lib.parseGitInvocations(
    "git -c alias.a=b -c alias.b=c -c alias.c=d -c alias.d=e -c alias.e=push a"
  )[0];
  assert.equal(deep.unresolved, "alias");
  assert.match(deep.error, /expands too deeply/);

  const shellAlias = lib.parseGitInvocations('git -c "alias.deploy=!git push origin main" deploy');
  assert.equal(shellAlias[0].unresolved, "command", "opaque shell alias is itself reported unresolved");
  assert.ok(shellAlias.some((invocation) => invocation.subcommand === "push"), "visible Git command inside alias is parsed");
});

test("COORD-1052: protected-branch checks resolve repository aliases and fail closed on unknown targets", () => {
  const root = tmpRoot();
  try {
    execFileSync("git", ["init", "-b", "feature"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "alias.deploy", "push origin main"], { cwd: root, stdio: "ignore" });
    const featureHead = () => ({ ok: true, branch: "feature", detached: false });

    const configured = lib.protectedBranchOperation("git deploy", {
      branches: ["main"],
      actingRoot: root,
      currentBranchFor: featureHead,
    });
    assert.equal(configured.blocked, true, "a repo-configured push alias must be judged as the push it runs");
    assert.equal(configured.rule, "names-protected-branch");

    const unavailable = lib.protectedBranchOperation("git deploy", {
      branches: ["main"],
      actingRoot: path.join(root, "missing-repo"),
      currentBranchFor: featureHead,
    });
    assert.equal(unavailable.blocked, true);
    assert.equal(unavailable.rule, "unresolvable-alias");

    const allBranches = lib.protectedBranchOperation("git push --all origin", {
      branches: ["main"],
      actingRoot: root,
      currentBranchFor: featureHead,
      listLocalBranches: () => ({ ok: true, branches: ["feature", "main"] }),
    });
    assert.equal(allBranches.rule, "names-protected-branch");

    const unreadableBranches = lib.protectedBranchOperation("git push --all origin", {
      branches: ["main"],
      actingRoot: root,
      currentBranchFor: featureHead,
      listLocalBranches: () => ({ ok: false, branches: [], error: "cannot enumerate refs" }),
    });
    assert.equal(unreadableBranches.blocked, true);
    assert.equal(unreadableBranches.rule, "unverifiable-push-targets");

    const listed = lib.listLocalBranches({ cwd: root }, { execFileSync: (_bin, args) => {
      assert.deepEqual(args.slice(-2), ["--format=%(refname:short)", "refs/heads"]);
      return "feature\nmain\n";
    } });
    assert.deepEqual(listed, { ok: true, branches: ["feature", "main"], error: null });
    const failedListing = lib.listLocalBranches({ cwd: root }, { execFileSync: () => { throw new Error("fixture git failure"); } });
    assert.equal(failedListing.ok, false);
    assert.match(failedListing.error, /fixture git failure/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("gitMutationKind: merge/cherry-pick/push only, and sequencer control is not a landing", () => {
  const kind = (cmd) => lib.parseGitInvocations(cmd).map((i) => lib.gitMutationKind(i));
  assert.deepEqual(kind("git merge abc"), ["merge"]);
  assert.deepEqual(kind("git cherry-pick abc"), ["cherry-pick"]);
  assert.deepEqual(kind("git push origin x"), ["push"]);
  assert.deepEqual(kind("git merge-base --is-ancestor abc main"), [null]);
  assert.deepEqual(kind("git log --merges"), [null]);
  // recovery paths must stay usable
  assert.deepEqual(kind("git merge --abort"), [null]);
  assert.deepEqual(kind("git cherry-pick --continue"), [null]);
});

test("protectedBranchMutation ignores option VALUES: a commit message is not a ref", () => {
  const branches = ["main"];
  assert.equal(lib.protectedBranchMutation('git merge abc123 -m "merge into main"', branches), null);
  assert.equal(lib.protectedBranchMutation("git merge abc123 --strategy-option ours", branches), null);
  // an actual ref argument still hits
  assert.equal(lib.protectedBranchMutation('git merge main -m "take it"', branches), "main");
});

test("COORD-664 RED: a by-SHA landing onto the branch under HEAD is refused", () => {
  const branches = ["main", "dev"];
  const onMain = { ok: true, branch: "main", detached: false, source: "git symbolic-ref --short HEAD" };
  const onFeature = { ok: true, branch: "agent/x-coord-664", detached: false, source: "git symbolic-ref --short HEAD" };

  for (const cmd of ["git merge --no-ff d8867889", "git cherry-pick ed144e9a"]) {
    const blocked = lib.protectedBranchOperation(cmd, { branches, currentBranch: onMain });
    assert.equal(blocked.blocked, true, `must refuse while HEAD is protected: ${cmd}`);
    assert.equal(blocked.rule, "head-on-protected-branch");
    assert.equal(blocked.branch, "main");

    const allowed = lib.protectedBranchOperation(cmd, { branches, currentBranch: onFeature });
    assert.equal(allowed.blocked, false, `must allow on a feature branch: ${cmd}`);
  }
});

test("COORD-664 is not a blanket refusal: reads, feature-branch work and prose stay allowed", () => {
  const branches = ["main"];
  const onMain = { ok: true, branch: "main", detached: false };
  const allowed = [
    "git merge-base --is-ancestor d8867889 main",
    "git branch --contains d8867889 main",
    "git log --oneline -5",
    "git status --porcelain",
    'coord/scripts/gov file-ticket --repo X --type bug --pri P0 --description "the guard permitted git merge d8867889 on main"',
  ];
  for (const cmd of allowed) {
    const decision = lib.protectedBranchOperation(cmd, { branches, currentBranch: onMain });
    assert.equal(decision.blocked, false, `must stay allowed while HEAD is protected: ${cmd}`);
  }
});

test("COORD-664 spoof resistance: command text cannot steer the current-branch answer", () => {
  const branches = ["main"];
  const onMain = { ok: true, branch: "main", detached: false };
  // naming a NON-protected branch while standing on a protected one still refuses
  for (const cmd of [
    "git merge feature/work",
    "git merge agent/claudea660-coord-664",
    "git -C /elsewhere/repo cherry-pick deadbeef",
  ]) {
    const decision = lib.protectedBranchOperation(cmd, { branches, currentBranch: onMain });
    assert.equal(decision.blocked, true, `spoof must not succeed: ${cmd}`);
    assert.equal(decision.rule, "head-on-protected-branch");
  }
});

test("COORD-664 fail-closed: an unreadable current branch is 'cannot verify', not 'not protected'", () => {
  const branches = ["main"];
  const unresolved = { ok: false, branch: null, error: "not a git repository" };
  const decision = lib.protectedBranchOperation("git cherry-pick abc123", { branches, currentBranch: unresolved });
  assert.equal(decision.blocked, true);
  assert.equal(decision.rule, "unverifiable-current-branch");

  // a detached HEAD is a TRUSTWORTHY "not on a branch", so it is allowed
  const detached = { ok: true, branch: null, detached: true };
  assert.equal(lib.protectedBranchOperation("git cherry-pick abc123", { branches, currentBranch: detached }).blocked, false);
});

test("COORD-664 keeps push on destination/refspec semantics (no substring widening)", () => {
  const branches = ["main"];
  const onMain = { ok: true, branch: "main", detached: false };
  const onFeature = { ok: true, branch: "feature/work", detached: false };
  // explicit refspec to a non-protected ref is allowed even from a protected HEAD
  assert.equal(lib.protectedBranchOperation("git push origin feature/work", { branches, currentBranch: onMain }).blocked, false);
  assert.equal(lib.protectedBranchOperation("git push origin HEAD:feature/work", { branches, currentBranch: onMain }).blocked, false);
  // a bare push's destination IS the current branch — that is refspec semantics
  const bare = lib.protectedBranchOperation("git push", { branches, currentBranch: onMain });
  assert.equal(bare.blocked, true);
  assert.equal(bare.rule, "head-on-protected-branch");
  assert.equal(lib.protectedBranchOperation("git push", { branches, currentBranch: onFeature }).blocked, false);
  assert.equal(lib.protectedBranchOperation("git push -u origin feature/work", { branches, currentBranch: onFeature }).blocked, false);
});

test("COORD-637 distinguishes merge sources from protected push destinations", () => {
  const branches = ["main"];
  const feature = { ok: true, branch: "feature/work", detached: false };
  const main = { ok: true, branch: "main", detached: false };
  assert.equal(lib.protectedBranchOperation("git fetch origin main", { branches, currentBranch: feature }).blocked, false);
  assert.equal(lib.protectedBranchOperation("git merge main", { branches, currentBranch: feature }).blocked, false);
  assert.equal(lib.protectedBranchOperation("git merge main", { branches, currentBranch: main }).rule, "head-on-protected-branch");
  assert.equal(lib.protectedBranchOperation("git fetch origin main:main", { branches, currentBranch: feature }).rule, "names-protected-branch");
  assert.equal(lib.protectedBranchOperation('gov file-ticket --description "git merge main"', { branches, currentBranch: main }).blocked, false);
});

test("COORD-637 resolves HEAD from git -C target repositories", () => {
  assert.equal(lib.resolveEffectiveGitRoot("git -C /tmp/feature merge main", "/repo"), "/tmp/feature");
  assert.equal(lib.resolveEffectiveGitRoot("git merge main", "/repo"), "/repo");
  const current = lib.protectedBranchOperation("git -C /tmp/feature merge main", {
    branches: ["main"],
    currentBranch: { ok: true, branch: "feature/work", detached: false },
  });
  assert.equal(current.blocked, false);
});

test("resolveCurrentBranch reads trusted repo state and reports failure instead of guessing", () => {
  const calls = [];
  const onBranch = lib.resolveCurrentBranch("/repo", {
    execFileSync: (bin, args) => {
      calls.push([bin, ...args].join(" "));
      return "agent/claudea660-coord-664\n";
    },
  });
  assert.equal(onBranch.ok, true);
  assert.equal(onBranch.branch, "agent/claudea660-coord-664");
  assert.match(calls[0], /^git -C \S+ symbolic-ref --quiet --short HEAD$/);

  const detached = lib.resolveCurrentBranch("/repo", {
    execFileSync: (bin, args) => {
      if (args.includes("symbolic-ref")) throw new Error("exit 1");
      return "HEAD\n";
    },
  });
  assert.equal(detached.ok, true);
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, null);

  const broken = lib.resolveCurrentBranch("/nope", {
    execFileSync: () => {
      throw new Error("not a git repository");
    },
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.branch, null);
  assert.match(String(broken.error), /not a git repository/);
});

test("loadIntegrationBranchMap reads project.config.js with engine default fallback", () => {
  const root = tmpRoot();
  writeConfig(root, {
    B: { path: "api", integrationBranch: "release-2026" },
    F: { path: "app" }, // omitted -> engine default
  });
  const { map, source, error } = lib.loadIntegrationBranchMap(root);
  assert.equal(error, null);
  assert.equal(source, "coord/project.config.js");
  assert.equal(map.B, "release-2026");
  assert.equal(map.F, lib.DEFAULT_INTEGRATION_BRANCH);
  fs.rmSync(root, { recursive: true, force: true });
});

test("loadProtectedBranches adds the coord workspace base and fails observably", () => {
  const root = tmpRoot();
  writeConfig(root, { B: { path: "api", integrationBranch: "dev" } });
  const ok = lib.loadProtectedBranches(root);
  assert.deepEqual(new Set(ok.branches), new Set(["dev", lib.COORD_WORKSPACE_BRANCH]));

  const broken = lib.loadProtectedBranches(path.join(root, "nope"));
  assert.equal(broken.branches, null);
  assert.match(String(broken.error), /cannot resolve integration branches/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("COORD-895: a configured non-main board branch replaces main in the protected set (config fallback path)", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "coord"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "coord", "project.config.js"),
    `module.exports = ${JSON.stringify({ boardBranch: " governance ", repos: { B: { path: "api", integrationBranch: "dev" } } })};\n`
  );
  const loaded = lib.loadIntegrationBranchMap(root);
  assert.equal(loaded.source, "coord/project.config.js");
  assert.equal(loaded.boardBranch, "governance");
  const ok = lib.loadProtectedBranches(root);
  assert.deepEqual(new Set(ok.branches), new Set(["dev", "governance"]), "main is no longer protected as the board");
  assert.equal(lib.protectedBranchOperation("git push origin governance", { branches: ok.branches }).blocked, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("COORD-895: the board branch comes from coord/paths.js when it loads, with the constant only as fallback", () => {
  const root = tmpRoot();
  const pathsModule = (boardBranch) => ({
    createCoordPaths: () => ({ repoIntegrationBranches: { B: "dev", F: "  " }, boardBranch }),
  });
  for (const [boardBranch, expected] of [["trunk", "trunk"], [undefined, lib.COORD_WORKSPACE_BRANCH], ["  ", lib.COORD_WORKSPACE_BRANCH]]) {
    const requireFn = (file) => {
      assert.equal(file, path.join(root, "coord", "paths.js"));
      return pathsModule(boardBranch);
    };
    const loaded = lib.loadIntegrationBranchMap(root, { requireFn });
    assert.equal(loaded.source, "coord/paths.js");
    assert.deepEqual(loaded.map, { B: "dev" });
    assert.equal(loaded.boardBranch, expected);
    assert.deepEqual(new Set(lib.loadProtectedBranches(root, { requireFn }).branches), new Set(["dev", expected]));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("integrationDiffRange never hardcodes origin/dev", () => {
  assert.equal(lib.integrationDiffRange("main", true), "origin/main~1..origin/main");
  assert.equal(lib.integrationDiffRange("release-2026", false), "release-2026~1..release-2026");
});

test("readHookPayload prefers env vars and falls back to hook JSON stdin", () => {
  const fromEnv = lib.readHookPayload({ TOOL_INPUT: "git status", TOOL_OUTPUT: "clean" }, "");
  assert.deepEqual(fromEnv, { toolInput: "git status", toolOutput: "clean" });

  const fromStdin = lib.readHookPayload(
    {},
    JSON.stringify({ tool_input: { command: "git push origin main" }, tool_response: { out: "x" } })
  );
  assert.equal(fromStdin.toolInput, "git push origin main");
  assert.match(fromStdin.toolOutput, /"out"/);

  const junk = lib.readHookPayload({}, "not json");
  assert.deepEqual(junk, { toolInput: "", toolOutput: "" });
});

// --- COORD-691 acceptance (e): the governed push does NOT relax the guard ----
//
// COORD-691 adds a governed pre-closeout push so an agent can complete a
// Repo-X landing. The whole design turns on the guard being left alone: the fix
// is a verb that performs the push under governance, never a recognition rule
// that lets a blessed caller through. A recognition rule would be a credential,
// and the credential would live in the same place as the attacker. These
// assertions fail if a later change tries to buy convenience by weakening the
// guard instead.
test("COORD-691: a hand-run push to a protected branch is STILL refused after the governed push exists", () => {
  const branches = ["main", "release-2026"];
  assert.equal(lib.protectedBranchMutation("git push origin main", branches), "main");
  assert.equal(lib.protectedBranchMutation("git push origin HEAD:main", branches), "main");
  assert.equal(lib.protectedBranchMutation("git push --force origin main", branches), "main");
});

test("COORD-691: no environment variable or caller marker unlocks the guard", () => {
  const branches = ["main"];
  // The governed push is opted into with COORD_PUSH_BEFORE_CLOSEOUT, which is
  // read by the ENGINE. It must not double as a guard bypass: the guard's
  // decision is a pure function of the command and the configured branches.
  const saved = process.env.COORD_PUSH_BEFORE_CLOSEOUT;
  process.env.COORD_PUSH_BEFORE_CLOSEOUT = "1";
  try {
    assert.equal(lib.protectedBranchMutation("git push origin main", branches), "main");
    assert.equal(
      lib.protectedBranchMutation("COORD_PUSH_BEFORE_CLOSEOUT=1 git push origin main", branches),
      "main",
      "spelling the opt-in inline must not launder the command either"
    );
  } finally {
    if (saved === undefined) delete process.env.COORD_PUSH_BEFORE_CLOSEOUT;
    else process.env.COORD_PUSH_BEFORE_CLOSEOUT = saved;
  }
});


test("COORD-1052: configured alias cycles are bounded and cannot bypass protected branch checks", () => {
  const seen = [];
  const root = path.resolve(os.tmpdir(), "coord-hook-resolver-fixture");
  const targetRoot = path.join(root, "nested");
  const result = lib.protectedBranchOperation("git -C nested deploy", {
    branches: ["main"], actingRoot: root, processEnv: {},
    aliasFor: (target, name) => {
      seen.push([target.cwd, name]);
      return { ok: true, value: name === "deploy" ? "publish" : "deploy" };
    },
    currentBranchFor: () => assert.fail("an unresolved alias must refuse before reading branch state"),
  });
  assert.equal(result.blocked, true);
  assert.equal(result.rule, "unresolvable-alias");
  assert.match(result.detail, /expands too deeply/);
  assert.equal(result.target, targetRoot);
  assert.ok(seen.length > 1 && seen.length <= 4, "cyclic aliases must stop after a bounded number of lookups");
  assert.ok(seen.every(([cwd]) => cwd === targetRoot), "each alias resolves in the targeted repository");
});

test("COORD-1052: missing resolver results refuse alias, current-branch and all-branch mutations", () => {
  const options = { branches: ["main"], actingRoot: path.resolve(os.tmpdir(), "coord-hook-resolver-fixture"), processEnv: {} };
  const alias = lib.protectedBranchOperation("git deploy", { ...options, aliasFor: () => null });
  assert.equal(alias.blocked, true);
  assert.equal(alias.rule, "unresolvable-alias");
  assert.match(alias.detail, /was not resolved/);
  const branch = lib.protectedBranchOperation("git reset --hard HEAD~1", { ...options, currentBranchFor: () => null });
  assert.equal(branch.blocked, true);
  assert.equal(branch.rule, "unverifiable-current-branch");
  assert.match(branch.error, /current branch was not resolved/);
  const all = lib.protectedBranchOperation("git push --all origin", {
    ...options, currentBranchFor: () => ({ ok: true, branch: "feature" }), listLocalBranches: () => null,
  });
  assert.equal(all.blocked, true);
  assert.equal(all.rule, "unverifiable-push-targets");
  assert.match(all.error, /local branches were not listed/);
});

test("COORD-1052: timeout wrappers preserve protected ref and current HEAD decisions", () => {
  const wrappers = [
    "timeout 5", "/usr/bin/timeout -s TERM -k 1 5",
    "timeout --signal TERM --kill-after 1 5",
    "timeout --signal=TERM --kill-after=1 5",
    "timeout --sig TERM 5", "timeout --kill-a 1 5",
    "timeout -vk 1 5", "timeout -vvk 1 5", "timeout -vs TERM 5",
    "timeout -v 5", "timeout -vv 5", "timeout -k1s 5", "timeout -sTERM 5",
    "timeout --preserve-status -- 5", "env timeout 5", "timeout 5 env -u UNUSED",
  ];
  const protectedHead = { ok: true, branch: "main", detached: false };
  const featureHead = { ok: true, branch: "feature/work", detached: false };
  for (const wrapper of wrappers) {
    const command = `${wrapper} git merge deadbeef`;
    assert.deepEqual(lib.parseGitInvocations(command).map((entry) => entry.subcommand), ["merge"], command);
    const blocked = lib.protectedBranchOperation(command, { branches: ["main"], currentBranch: protectedHead });
    assert.equal(blocked.blocked, true, command);
    assert.equal(blocked.rule, "head-on-protected-branch", command);
    assert.equal(lib.protectedBranchOperation(command, { branches: ["main"], currentBranch: featureHead }).blocked, false);
    const push = lib.protectedBranchOperation(`${wrapper} git push origin main`, {
      branches: ["main"], currentBranch: featureHead,
    });
    assert.equal(push.blocked, true, wrapper);
    assert.equal(push.rule, "names-protected-branch", wrapper);
    for (const safe of ["git status", "git merge-base --is-ancestor deadbeef main", "echo 'git merge main'"]) {
      assert.equal(lib.gitCommandNeedsDecision(`${wrapper} ${safe}`), false, `${wrapper} ${safe}`);
    }
  }
  for (const incomplete of ["timeout", "timeout 5", "timeout --signal TERM", "timeout --kill-after=1 5",
    "timeout --sig", "timeout --kill-a", "timeout -vk", "timeout -vs"]) {
    assert.deepEqual(lib.parseGitInvocations(incomplete), [], incomplete);
  }
});

test("COORD-1052: Git target options survive wrappers and preserve repository precedence", () => {
  const command = "env -u UNUSED git -C parent -C child --git-dir=metadata --work-tree=checkout push origin main";
  const [invocation] = lib.parseGitInvocations(command);
  assert.equal(invocation.subcommand, "push");
  assert.equal(invocation.gitDir, "metadata");
  assert.equal(invocation.workTree, "checkout");
  assert.deepEqual(lib.resolveGitTarget(invocation, "/workspace", { GIT_DIR: "/wrong", GIT_WORK_TREE: "/wrong" }), {
    cwd: "/workspace/parent/child", gitDir: "/workspace/parent/child/metadata", workTree: "/workspace/parent/child/checkout",
  });
  const [spaced] = lib.parseGitInvocations("git --git-dir metadata --work-tree checkout status");
  assert.equal(spaced.gitDir, "metadata");
  assert.equal(spaced.workTree, "checkout");
  for (const text of ["git", "git --git-dir", "git --work-tree", "timeout", "$EDITOR file"]) {
    assert.deepEqual(lib.parseGitInvocations(text), [], text);
  }
  assert.deepEqual(lib.parseGitInvocations("git push origin main", 4), []);
  for (const flag of ["--git-dir=$UNKNOWN", "--work-tree=$UNKNOWN"]) {
    const result = lib.protectedBranchOperation(`git ${flag} merge topic`, {
      branches: ["main"], actingRoot: "/workspace", processEnv: {},
      currentBranchFor: () => assert.fail("unknown repository must refuse before branch lookup"),
    });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, "unresolvable-expansion");
  }
});

test("COORD-1052: branch lookup fallback retains explicit target and refuses empty answers", () => {
  const target = { cwd: "/workspace", gitDir: "/metadata", workTree: "/checkout" };
  for (const [answer, branch, detached] of [["topic\n", "topic", false], ["HEAD\n", null, true]]) {
    const calls = [];
    const result = lib.resolveCurrentBranch(target, { execFileSync: (bin, args) => {
      assert.equal(bin, "git");
      assert.deepEqual(args.slice(0, 6), ["-C", "/workspace", "--git-dir", "/metadata", "--work-tree", "/checkout"]);
      calls.push(args.slice(6));
      return calls.length === 1 ? undefined : answer;
    } });
    assert.equal(result.ok, true);
    assert.equal(result.branch, branch);
    assert.equal(result.detached, detached);
    assert.deepEqual(calls, [["symbolic-ref", "--quiet", "--short", "HEAD"], ["rev-parse", "--abbrev-ref", "HEAD"]]);
  }
  const empty = lib.resolveCurrentBranch(undefined, { execFileSync: () => undefined });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /produced no branch name/);
  const thrown = lib.resolveCurrentBranch(target, { execFileSync: () => { throw "fixture unavailable"; } });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /fixture unavailable/);
});

test("COORD-1052: branch enumeration preserves target scope and distinguishes failure from emptiness", () => {
  const target = { cwd: "/workspace", gitDir: "/metadata", workTree: "/checkout" };
  const empty = lib.listLocalBranches(target, { execFileSync: (bin, args) => {
    assert.equal(bin, "git");
    assert.deepEqual(args, ["-C", "/workspace", "--git-dir", "/metadata", "--work-tree", "/checkout", "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    return undefined;
  } });
  assert.deepEqual(empty, { ok: true, branches: [], error: null });
  const failed = lib.listLocalBranches(target, { execFileSync: () => { throw "fixture unavailable"; } });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /fixture unavailable/);
});

test("COORD-1052: hooks retain structured input and distinguish an empty protected set", () => {
  assert.deepEqual(lib.parseGitInvocations(), []);
  assert.equal(lib.gitCommandNeedsDecision("git commit -- --amend"), false,
    "a filename after the option terminator does not request a history rewrite");
  const input = { file_path: "notes.txt", content: "fixture" };
  assert.deepEqual(lib.readHookPayload({}, JSON.stringify({ tool_input: input })), {
    toolInput: JSON.stringify(input), toolOutput: "",
  });
  assert.deepEqual(lib.protectedBranchOperation("git merge topic", { branches: [] }), {
    risky: true, blocked: false, rule: null, branch: null, kind: null,
  });
  assert.deepEqual(lib.resolveGitTarget(null, undefined, {}), { cwd: process.cwd(), gitDir: null, workTree: null });
});


test("COORD-1052: an unreadable local Git config cannot make an unknown alias bypass the hook", (t) => {
  const root = tmpRoot(t);
  execFileSync("git", ["init", "-q", "-b", "feature"], { cwd: root, stdio: "ignore" });
  const missing = lib.protectedBranchOperation("git coord-test-unconfigured-alias", {
    branches: ["main"], actingRoot: root, processEnv: {},
  });
  assert.deepEqual(missing, { risky: true, blocked: false, rule: null, branch: null, kind: null },
    "an absent alias is distinct from a Git configuration read failure");
  const config = path.join(root, ".git", "config");
  const before = "[core\nmalformed local Git config\n";
  fs.writeFileSync(config, before);
  let branchLookups = 0;
  const result = lib.protectedBranchOperation("git deploy", {
    branches: ["main"], actingRoot: root, processEnv: {},
    currentBranchFor: () => { branchLookups += 1; return { ok: true, branch: "feature", detached: false }; },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.rule, "unresolvable-alias");
  assert.match(result.detail, /cannot read alias\.deploy/);
  assert.equal(branchLookups, 0, "the guard refuses before trusting branch state from an unreadable alias target");
  assert.equal(fs.readFileSync(config, "utf8"), before, "alias resolution is read-only");
});

test("COORD-1052: common command wrappers do not hide protected branch mutation", () => {
  const wrappers = [
    "env -u UNUSED", "sudo", "doas", "command", "builtin", "exec", "nohup", "time",
    "nice -n 5", "ionice -c 2 -n 7", "stdbuf -oL", "xargs -I {}",
  ];
  for (const wrapper of wrappers) {
    const command = `${wrapper} git branch -D main`;
    const invocations = lib.parseGitInvocations(command);
    assert.equal(invocations.length, 1, `wrapper parsing retains one Git operation: ${command}`);
    assert.equal(invocations[0].subcommand, "branch", command);
    const result = lib.protectedBranchOperation(command, { branches: ["main"] });
    assert.equal(result.blocked, true, `wrapper must not hide the protected ref deletion: ${command}`);
    assert.equal(result.rule, wrapper.startsWith("xargs") ? "unresolvable-expansion" : "moves-protected-branch", command);
    if (!wrapper.startsWith("xargs")) assert.equal(result.branch, "main", command);
  }
});


test("COORD-1052: actual alias lookup respects explicit Git directory and worktree scope", (t) => {
  const root = tmpRoot(t), acting = tmpRoot(t);
  execFileSync("git", ["init", "-q", "-b", "feature", root]);
  execFileSync("git", ["init", "-q", "-b", "feature", acting]);
  execFileSync("git", ["-C", acting, "config", "--local", "alias.coord1052target", "status"]);
  execFileSync("git", ["-C", root, "config", "--local", "alias.coord1052target", "push"]);
  const { shellQuote } = require("../git-ops.js");
  const command = `git --git-dir=${shellQuote(path.join(root, ".git"))} --work-tree=${shellQuote(root)} coord1052target origin main`;
  const config = path.join(root, ".git", "config");
  const before = fs.readFileSync(config);
  const options = { branches: ["main"], actingRoot: acting, processEnv: {} };
  const protectedResult = lib.protectedBranchOperation(command, options);
  assert.equal(protectedResult.blocked, true);
  assert.equal(protectedResult.rule, "names-protected-branch");
  assert.equal(protectedResult.branch, "main", "the alias in the targeted repository wins over the acting repository");
  assert.deepEqual(fs.readFileSync(config), before, "hook lookup never rewrites config");
  execFileSync("git", ["-C", root, "config", "--local", "alias.coord1052target", ""]);
  const emptyBytes = fs.readFileSync(config);
  const empty = lib.protectedBranchOperation(command, options);
  assert.equal(empty.blocked, false, "an empty alias cannot name a protected-ref operation");
  assert.equal(empty.rule, null);
  assert.deepEqual(fs.readFileSync(config), emptyBytes);
});
