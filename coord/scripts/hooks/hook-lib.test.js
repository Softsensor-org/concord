"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const lib = require("./hook-lib.js");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coord-hook-lib-"));
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
