"use strict";

// COORD-948 — adversarial corpus for the pre-bash protected-branch guard.
//
// Every row is a command string with the expected decision. Each BLOCK row is
// asserted from two HEAD states: a feature branch and a protected branch. The
// guard must refuse the command on both, because the bypass question is whether
// the command can reach a protected ref, not whether HEAD happens to be on one.
//
// Git state is injected (branch reader, branch listing, alias reader) so the
// corpus is deterministic. The child-process case at the bottom runs the real
// pre-bash-guard.js against the real workspace.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const lib = require("./hook-lib.js");

const PROTECTED = ["main", "dev"];
const LOCAL_BRANCHES = ["main", "dev", "agent/feature-x"];
const HEADS = {
  feature: { ok: true, branch: "agent/feature-x", detached: false, source: "corpus" },
  protected: { ok: true, branch: "main", detached: false, source: "corpus" },
};
// Only `p` is an alias in the corpus workspace; it expands to push.
const ALIASES = { p: "push" };

function decide(command, head) {
  return lib.protectedBranchOperation(command, {
    branches: PROTECTED,
    actingRoot: "/corpus/ws",
    processEnv: {},
    currentBranchFor: () => HEADS[head],
    listLocalBranches: () => ({ ok: true, branches: LOCAL_BRANCHES, error: null }),
    aliasFor: (_target, name) => ({ ok: true, value: ALIASES[name] || null }),
  });
}

// [label, command, expected]. expected is "block" or "allow".
const BLOCK = [
  // Literal protected refs and refspec forms (already covered; kept as the floor).
  ["literal protected push", "git push origin main"],
  ["HEAD:main refspec", "git push origin HEAD:main"],
  ["+main force refspec", "git push origin +main"],
  ["':main' delete refspec", "git push origin :main"],
  ["refs/heads/main full ref", "git push origin refs/heads/main"],
  // Whole-repository pushes that name every local branch.
  ["push --all", "git push --all origin"],
  ["push --mirror", "git push --mirror origin"],
  ["push --tags with protected refspec", "git push --tags origin main"],
  // Shell-variable refspecs: the guard cannot know the value.
  ["variable refspec $B", 'B=main; git push origin "$B"'],
  ["variable refspec ${B}", "git push origin ${B}"],
  ["variable inside refspec", "git push origin HEAD:refs/heads/$B"],
  // Command substitution and backticks in a refspec.
  ["command substitution refspec", "git push origin $(echo main)"],
  ["backtick refspec", "git push origin `echo main`"],
  // Target-repository flags whose value is an expansion.
  ["-C with variable directory", 'git -C "$d" push'],
  ["GIT_DIR from a variable", "GIT_DIR=$x git push"],
  // The git binary or subcommand is named through a variable or wrapper.
  ["git binary in a variable", "g=git; $g push origin main"],
  ["git binary in a variable, feature push", "g=git; $g push origin agent/feature-x"],
  ["subcommand from a variable", "git $g origin main"],
  ["git alias invoked via a variable", "git $g origin main"],
  ["inline alias via -c", "git -c alias.x=push x origin main"],
  ["configured alias p", "git p origin main"],
  ["command git push", "command git push origin main"],
  ["env git push", "env git push origin main"],
  ["env -i git push", "env -i git push origin main"],
  ["backslash-escaped git", "\\git push origin main"],
  ["bash -c wrapper", "bash -c 'git push origin main'"],
  ["sh -c wrapper", 'sh -c "git push --all origin"'],
  ["bash -c wrapper with variable binary", "bash -c '$g push origin main'"],
  ["xargs git push fed a refspec", "echo main | xargs git push origin"],
  ["nested substitution runs a push", 'git commit -m "$(git push origin main)"'],
];

const ALLOW = [
  ["push a feature branch", "git push origin agent/feature-x"],
  ["push -u with agent branch", "git push -u origin agent/feature-x"],
  ["message that mentions a protected name", 'git commit -m "merge into main"'],
  ["message containing a dollar sign", 'git commit -m "cost is $5 today"'],
  ["plain status", "git status"],
  ["alias-looking word that is not configured", "git foo origin feature"],
];

for (const [label, command] of BLOCK) {
  for (const head of ["feature", "protected"]) {
    test(`corpus BLOCK (${head} HEAD): ${label}`, () => {
      const decision = decide(command, head);
      assert.equal(decision.blocked, true, `expected a refusal for: ${command}; got ${JSON.stringify(decision)}`);
    });
  }
}

for (const [label, command] of ALLOW) {
  for (const head of ["feature", "protected"]) {
    test(`corpus ALLOW (${head} HEAD): ${label}`, () => {
      const decision = decide(command, head);
      assert.equal(decision.blocked, false, `expected allow for: ${command}; got ${JSON.stringify(decision)}`);
    });
  }
}

// The real guard, out of process, with a real PreToolUse payload. Exit code 2 is
// the Claude Code blocking code. Runs in the worktree, whose config is real.
test("child process: pre-bash-guard.js refuses `git push --mirror origin` with exit 2", () => {
  const hooksDir = path.resolve(__dirname);
  const guard = path.join(hooksDir, "pre-bash-guard.js");
  const workspace = path.resolve(hooksDir, "..", "..", "..", "..");
  const result = spawnSync(process.execPath, [guard], {
    cwd: workspace,
    env: { ...process.env, TOOL_INPUT: "git push --mirror origin", TOOL_OUTPUT: "" },
    input: JSON.stringify({ tool_input: { command: "git push --mirror origin" } }),
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}; stderr=${result.stderr}`);
});

// COORD-948 acceptance 5: no environment variable, flag or config switch disables
// the rule. The decision is a pure function of the command and trusted state; the
// environment only supplies GIT_DIR/GIT_WORK_TREE values, never an opt-out.
test("no environment switch disables the protected-branch rule", () => {
  const escapeHatches = {
    COORD_PUSH_BEFORE_CLOSEOUT: "1",
    COORD_ALLOW_PROTECTED_PUSH: "1",
    COORD_GUARD_DISABLE: "1",
    COORD_SKIP_PROTECTED_BRANCH_GUARD: "1",
    HUMAN_ADMIN_OVERRIDE: "approved",
  };
  for (const command of ["git push origin main", "git push --mirror origin", "git push origin $(echo main)"]) {
    const decision = lib.protectedBranchOperation(command, {
      branches: PROTECTED,
      actingRoot: "/corpus/ws",
      processEnv: escapeHatches,
      currentBranchFor: () => HEADS.feature,
      listLocalBranches: () => ({ ok: true, branches: LOCAL_BRANCHES, error: null }),
      aliasFor: () => ({ ok: true, value: null }),
    });
    assert.equal(decision.blocked, true, `escape-hatch env must not unlock: ${command}`);
  }
});

// COORD-969: history-rewriting verbs. Two kinds of protection.
//  - NAMED: the verb moves a protected ref itself (branch -f/-D/-M, checkout -B,
//    switch -C, update-ref). Refused from every HEAD, feature included.
//  - HEAD: the verb rewrites whatever branch HEAD is on (reset, rebase, commit
//    --amend). Refused only when HEAD is protected; allowed on a feature branch.
const NAMED_MOVE_BLOCK = [
  ["branch -f moves protected main", "git branch -f main HEAD~1"],
  ["branch --force with origin start point", "git branch --force main origin/dev"],
  ["branch -D deletes protected dev", "git branch -D dev"],
  ["branch -M renames protected main", "git branch -M main archive"],
  ["checkout -B resets protected main", "git checkout -B main origin/dev"],
  ["switch -C resets protected dev", "git switch -C dev"],
  ["update-ref full protected ref", "git update-ref refs/heads/main abc123"],
  ["update-ref delete of protected dev", "git update-ref -d refs/heads/dev"],
  ["update-ref short protected name", "git update-ref main abc123"],
  ["branch -f with a variable name", 'git branch -f "$B" HEAD'],
  ["update-ref with a variable ref", 'git update-ref "$R" abc123'],
  ["update-ref --stdin cannot be inspected", "git update-ref --stdin"],
  ["update-ref in a variable directory", 'git -C "$d" update-ref refs/heads/agent/feature-x abc123'],
];

const HEAD_REWRITE_ON_PROTECTED = [
  ["reset --hard onto origin/main", "git reset --hard origin/main"],
  ["reset --soft back two commits", "git reset --soft HEAD~2"],
  ["reset with no mode", "git reset HEAD~1"],
  ["rebase onto origin/dev", "git rebase origin/dev"],
  ["interactive rebase", "git rebase -i HEAD~3"],
  ["rebase --onto", "git rebase --onto origin/dev HEAD~2"],
  ["commit --amend without edit", "git commit --amend --no-edit"],
  ["commit --amend with a message", 'git commit --amend -m "fix"'],
];

const FEATURE_ALLOW = [
  ["reset --hard onto origin/main on feature", "git reset --hard origin/main"],
  ["rebase feature onto origin/dev", "git rebase origin/dev"],
  ["interactive rebase of feature", "git rebase -i HEAD~3"],
  ["commit --amend on feature", "git commit --amend --no-edit"],
  ["branch -f feature from a protected start point", "git branch -f agent/feature-x origin/dev"],
  ["checkout -B feature from origin/main", "git checkout -B agent/feature-x origin/main"],
  ["update-ref of a feature ref to a protected value", "git update-ref refs/heads/agent/feature-x refs/heads/main"],
  ["rebase --abort recovery", "git rebase --abort"],
  ["rebase --continue recovery", "git rebase --continue"],
  ["commit path named like an amend option", "git commit -- --amend"],
  ["commit message that mentions amend", 'git commit -m "explain --amend"'],
];

for (const [label, command] of NAMED_MOVE_BLOCK) {
  for (const head of ["feature", "protected"]) {
    test(`COORD-969 named move BLOCK (${head} HEAD): ${label}`, () => {
      const decision = decide(command, head);
      assert.equal(decision.blocked, true, `expected a refusal for: ${command}; got ${JSON.stringify(decision)}`);
    });
  }
}

for (const [label, command] of HEAD_REWRITE_ON_PROTECTED) {
  test(`COORD-969 HEAD rewrite BLOCK (protected HEAD): ${label}`, () => {
    const decision = decide(command, "protected");
    assert.equal(decision.blocked, true, `expected a refusal for: ${command}; got ${JSON.stringify(decision)}`);
  });
  test(`COORD-969 HEAD rewrite ALLOW on feature HEAD: ${label}`, () => {
    const decision = decide(command, "feature");
    assert.equal(decision.blocked, false, `feature-branch rewrite must stay allowed: ${command}; got ${JSON.stringify(decision)}`);
  });
}

for (const [label, command] of FEATURE_ALLOW) {
  for (const head of ["feature", "protected"]) {
    test(`COORD-969 ALLOW (${head} HEAD): ${label}`, () => {
      const decision = decide(command, head);
      // Feature-branch rewrites are allowed on a feature HEAD only; on a protected
      // HEAD the HEAD-rewrite rows above own that case, so skip the duplicate here.
      if (head === "protected" && /reset|rebase|commit --amend/.test(command) && !/--abort|--continue/.test(command)) return;
      assert.equal(decision.blocked, false, `expected allow for: ${command}; got ${JSON.stringify(decision)}`);
    });
  }
}
