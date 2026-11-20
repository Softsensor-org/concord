"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const GUARD = path.join(__dirname, "pre-bash-guard.js");

function temporaryRoot(prefix = "coord-pre-bash-guard-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env || process.env,
    input: options.input,
    timeout: 15000,
  });
  if (result.error) throw result.error;
  return result;
}

function git(root, args) {
  const result = runProcess("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Pre Bash Guard Test",
      GIT_AUTHOR_EMAIL: "pre-bash-guard@example.invalid",
      GIT_COMMITTER_NAME: "Pre Bash Guard Test",
      GIT_COMMITTER_EMAIL: "pre-bash-guard@example.invalid",
    },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo(root, branch, extraBranches = []) {
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init", "--quiet", "-b", branch]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  for (const extra of extraBranches) git(root, ["branch", extra]);
  return root;
}

function runGuard(command, options = {}) {
  const env = { ...process.env, TOOL_INPUT: command, TOOL_OUTPUT: "", ...options.env };
  if (options.noPayload) {
    delete env.TOOL_INPUT;
    delete env.TOOL_OUTPUT;
  }
  const args = [];
  if (options.preload) args.push("--require", options.preload);
  args.push(GUARD);
  return runProcess(process.execPath, args, { cwd: options.cwd || process.cwd(), env, input: options.stdin || "" });
}

function writeLoaderOverride(root, mode) {
  const file = path.join(root, `preload-${mode}.cjs`);
  const source = `
const Module = require("node:module");
const original = Module._load;
Module._load = function(request, parent, isMain) {
  const expected = process.env.COORD_GUARD_TEST_ENTRY;
  const mode = process.env.COORD_GUARD_TEST_MODE;
  if (parent && parent.filename === expected && request === "./hook-stdin.js" && mode === "unreadable-env") {
    const stdin = original.call(this, request, parent, isMain);
    return { ...stdin, acquireHookPayload: async () => ({ ok: false, stdinText: "", stdinReason: "not-consulted", stdinConsulted: false }) };
  }
  if (parent && parent.filename === expected && request === "./hook-lib.js") {
    if (mode === "load-text-failure") throw "injected hook library text failure";
    if (process.env.COORD_GUARD_TEST_MODE === "load-failure") throw new Error("injected hook library load failure");
    const lib = original.call(this, request, parent, isMain);
    if (process.env.COORD_GUARD_TEST_MODE === "root-failure") {
      return { ...lib, trustedEngineRoot() { throw new Error("injected trusted root failure"); } };
    }
    if (process.env.COORD_GUARD_TEST_MODE === "config-failure") {
      return { ...lib, loadProtectedBranches() { return { branches: null, source: null, error: "injected invalid engine config" }; } };
    }
    if (process.env.COORD_GUARD_TEST_MODE === "unknown-block") {
      return { ...lib, protectedBranchOperation() { return { risky: true, blocked: true, rule: "future-unknown-rule", kind: "merge" }; } };
    }
    if (["allowed", "untyped-block", "untyped-expansion"].includes(mode)) {
      const decision = mode === "allowed" ? { risky: true, blocked: false } :
        mode === "untyped-block" ? { risky: true, blocked: true, rule: "future-rule" } :
          { risky: true, blocked: true, rule: "unresolvable-expansion", target: process.cwd(), token: "opaque fixture token" };
      return { ...lib, gitCommandNeedsDecision: () => true, protectedBranchOperation: () => decision };
    }
    return lib;
  }
  return original.call(this, request, parent, isMain);
};
`;
  fs.writeFileSync(file, source, "utf8");
  return file;
}

function injected(command, mode, root, options = {}) {
  const preload = writeLoaderOverride(root, mode);
  return runGuard(command, {
    ...options,
    preload,
    env: {
      ...(options.env || {}),
      COORD_GUARD_TEST_ENTRY: GUARD,
      COORD_GUARD_TEST_MODE: mode,
    },
  });
}

test("entrypoint catches required-module and trusted-root failures as blocking refusals", (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const loadFailure = injected("git merge topic", "load-failure", root);
  assert.equal(loadFailure.status, 2, loadFailure.stderr);
  assert.match(loadFailure.stderr, /cannot load its engine modules: injected hook library load failure/);
  assert.match(loadFailure.stderr, /OUT-OF-BAND RECOVERY/);
  const loadTextFailure = injected("git status", "load-text-failure", root);
  assert.equal(loadTextFailure.status, 2, loadTextFailure.stderr);
  assert.match(loadTextFailure.stderr, /cannot load its engine modules: injected hook library text failure/);
  const required = runProcess(process.execPath, [
    "--require", writeLoaderOverride(root, "load-failure"),
    "-e", 'const assert = require("node:assert/strict"); assert.throws(() => require(process.argv[1]), /injected hook library load failure/);',
    GUARD,
  ], { cwd: root, env: { ...process.env, COORD_GUARD_TEST_ENTRY: GUARD, COORD_GUARD_TEST_MODE: "load-failure" } });
  assert.equal(required.status, 0, required.stderr);

  const rootFailure = injected("git merge topic", "root-failure", root);
  assert.equal(rootFailure.status, 2, rootFailure.stderr);
  assert.match(rootFailure.stderr, /pre-bash-guard crashed: injected trusted root failure/);
  assert.match(rootFailure.stderr, /OUT-OF-BAND RECOVERY/);
});

test("empty payload and unresolvable protected-branch policy refuse; harmless commands pass", (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const noPayload = runGuard("", { noPayload: true, cwd: root });
  assert.equal(noPayload.status, 2, noPayload.stderr);
  assert.match(noPayload.stderr, /BLOCKED \(fail-closed\): this PreToolUse guard received no command/);
  assert.match(noPayload.stderr, /Reason:/);
  assert.match(noPayload.stderr, /retry the command/);
  const unreadableEnv = injected("", "unreadable-env", root);
  assert.equal(unreadableEnv.status, 2, unreadableEnv.stderr);
  assert.match(unreadableEnv.stderr, /TOOL_INPUT was empty/);
  const allowed = injected("git status", "allowed", root);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stderr, "");
  const untypedBlock = injected("git status", "untyped-block", root);
  assert.equal(untypedBlock.status, 2, untypedBlock.stderr);
  assert.match(untypedBlock.stderr, /refused this git command \(rule future-rule\)/);
  const untypedExpansion = injected("git status", "untyped-expansion", root);
  assert.equal(untypedExpansion.status, 2, untypedExpansion.stderr);
  assert.match(untypedExpansion.stderr, /opaque fixture token' \(git in /);

  const configFailure = injected("git merge topic", "config-failure", root, { cwd: root });
  assert.equal(configFailure.status, 2, configFailure.stderr);
  assert.match(configFailure.stderr, /cannot resolve the protected integration branches/);
  assert.match(configFailure.stderr, /injected invalid engine config/);
  assert.match(configFailure.stderr, /gov land \/ gov finalize/);

  const harmless = runGuard("git status --short", { cwd: root });
  assert.equal(harmless.status, 0, harmless.stderr);
});

test("canonical guard reports each protected-branch refusal with actionable context", (t) => {
  const root = temporaryRoot();
  const outsideGit = path.join(root, "outside-git");
  fs.mkdirSync(outsideGit);
  const protectedHead = makeRepo(path.join(root, "protected-head"), "dev");
  const featureHead = makeRepo(path.join(root, "feature-head"), "feature", ["dev"]);
  const preloadRoot = path.join(root, "preloads");
  fs.mkdirSync(preloadRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const named = runGuard("git push origin dev", { cwd: featureHead });
  assert.equal(named.status, 2, named.stderr);
  assert.match(named.stderr, /manual git merge\/cherry-pick\/push targeting protected integration branch 'dev'/);
  assert.match(named.stderr, /configured in coord\/(?:paths\.js|project\.config\.js)/);

  const headRewrite = runGuard("git reset --hard HEAD", { cwd: protectedHead });
  assert.equal(headRewrite.status, 2, headRewrite.stderr);
  assert.match(headRewrite.stderr, /HEAD is on protected integration branch 'dev'.*would rewrite it/);

  const headLanding = runGuard("git push", { cwd: protectedHead });
  assert.equal(headLanding.status, 2, headLanding.stderr);
  assert.match(headLanding.stderr, /HEAD is on protected integration branch 'dev'.*would land onto it/);
  assert.match(headLanding.stderr, /by-SHA landing/);

  const moved = runGuard("git branch -D dev", { cwd: featureHead });
  assert.equal(moved.status, 2, moved.stderr);
  assert.match(moved.stderr, /would move, rename or delete protected integration branch 'dev'/);

  const unreadableHead = runGuard("git push origin", { cwd: outsideGit });
  assert.equal(unreadableHead.status, 2, unreadableHead.stderr);
  assert.match(unreadableHead.stderr, /current branch could not be read/);
  assert.match(unreadableHead.stderr, /Run the operation inside the intended git repository/);

  const unresolvedExpansion = runGuard('git push origin "$TARGET"', { cwd: featureHead });
  assert.equal(unresolvedExpansion.status, 2, unresolvedExpansion.stderr);
  assert.match(unresolvedExpansion.stderr, /unresolvable shell expansion/);
  assert.match(unresolvedExpansion.stderr, /write the branch name literally/);

  const unresolvedAlias = runGuard("git -C /path/that/does/not/exist hook-alias", { cwd: featureHead });
  assert.equal(unresolvedAlias.status, 2, unresolvedAlias.stderr);
  assert.match(unresolvedAlias.stderr, /git subcommand 'hook-alias' may be an alias/);
  assert.match(unresolvedAlias.stderr, /cannot be verified/);

  const mirror = runGuard("git push --mirror origin", { cwd: featureHead });
  assert.equal(mirror.status, 2, mirror.stderr);
  assert.match(mirror.stderr, /--mirror force-updates and deletes every remote ref/);
  assert.match(mirror.stderr, /including protected integration branches/);

  const unverifiableAll = runGuard("git -C /path/that/does/not/exist push --all origin", { cwd: featureHead });
  assert.equal(unverifiableAll.status, 2, unverifiableAll.stderr);
  assert.match(unverifiableAll.stderr, /local branches could not be listed/);
  assert.match(unverifiableAll.stderr, /cannot be verified as not touching a protected branch/);

  const unknownRule = injected("git merge topic", "unknown-block", preloadRoot, { cwd: featureHead });
  assert.equal(unknownRule.status, 2, unknownRule.stderr);
  assert.match(unknownRule.stderr, /protected-branch guard refused this git merge \(rule future-unknown-rule\)/);
  assert.match(unknownRule.stderr, /Use gov land or gov finalize/);
});

test("COORD-1052: real PreToolUse JSON refuses timeout-wrapped protected branch writes", (t) => {
  const root = temporaryRoot("coord-timeout-guard-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(path.join(root, "repo"), "dev");
  const before = git(repo, ["rev-parse", "HEAD"]);
  for (const command of [
    `timeout --signal TERM --kill-after 1 5 git merge ${before}`,
    "timeout --signal=TERM --kill-after=1 5 git push origin dev",
    `timeout --sig TERM 5 git merge ${before}`,
    "timeout --kill-a 1 5 git push origin dev",
    `timeout -vk 1 5 git merge ${before}`,
    "timeout -vs TERM 5 git push origin dev",
  ]) {
    const result = runGuard("", {
      noPayload: true, cwd: repo, env: { GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    });
    assert.equal(result.status, 2, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /protected integration branch 'dev'/);
    assert.match(result.stderr, /gov land or gov finalize/);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), before, "the guard only inspects the payload");
  }
});
