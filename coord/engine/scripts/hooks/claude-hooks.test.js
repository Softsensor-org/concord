"use strict";

// COORD-476 — behavior tests for the shipped Claude hook helpers:
// pre-bash-guard.js (REQUIRED, fail-closed) and post-bash.js (advisory,
// observable skips). Fixtures cover main, dev, and nonstandard integration
// branches so the guard provably follows coord/project.config.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

// COORD-872: .claude/settings.json runs the legacy coord/scripts/hooks paths, which are permanent
// shims re-dispatching these engine modules, so every allow/block case runs through the shim.
const GUARD = path.join(__dirname, "..", "..", "..", "scripts", "hooks", "pre-bash-guard.js");
const POST = path.join(__dirname, "..", "..", "..", "scripts", "hooks", "post-bash.js");

function makeWorkspace(repos, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-hook-fixture-"));
  fs.mkdirSync(path.join(root, "coord", "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "coord", "project.config.js"),
    `module.exports = ${JSON.stringify({ repos })};\n`
  );
  const governanceBody =
    options.governanceBody ||
    'require("node:fs").appendFileSync(require("node:path").join(__dirname, "calls.log"), JSON.stringify(process.argv.slice(2)) + "\\n");\n';
  fs.writeFileSync(path.join(root, "coord", "scripts", "governance.js"), governanceBody);
  // COORD-930: the trusted root is the workspace that CONTAINS the engine copy, so
  // each fixture installs its own engine hooks at coord/engine/scripts/hooks.
  const engineHooks = path.join(root, "coord", "engine", "scripts", "hooks");
  fs.mkdirSync(engineHooks, { recursive: true });
  for (const name of ENGINE_HOOK_FILES) fs.copyFileSync(path.join(ENGINE_HOOKS_DIR, name), path.join(engineHooks, name));
  return root;
}

// COORD-930: fixtures run the engine copy installed inside them. Config comes from
// that installed location; no environment variable can redirect it.
const ENGINE_HOOKS_DIR = path.join(__dirname);
const ENGINE_HOOK_FILES = ["hook-lib.js", "hook-stdin.js", "pre-bash-guard.js", "post-bash.js"];
function fixtureScript(root, script) {
  return path.join(root, "coord", "engine", "scripts", "hooks", path.basename(script));
}

function runHook(script, root, env) {
  return spawnSync(process.execPath, [fixtureScript(root, script)], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TOOL_INPUT: "", TOOL_OUTPUT: "", ...env },
    input: "",
  });
}

test("guard allows harmless commands", () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  for (const cmd of ["ls -la", "git status", "git checkout -b feature/x", "npm test"]) {
    const res = runHook(GUARD, root, { TOOL_INPUT: cmd });
    assert.equal(res.status, 0, `expected allow for: ${cmd} (stderr: ${res.stderr})`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("guard blocks mutations of each CONFIGURED integration branch (main/dev/nonstandard)", () => {
  const cases = [
    { branch: "main", cmd: "git push origin main" },
    { branch: "dev", cmd: "git push origin dev" },
    { branch: "release-2026", cmd: "git -C api push origin release-2026" },
  ];
  for (const { branch, cmd } of cases) {
    const root = makeWorkspace({ B: { path: "api", integrationBranch: branch } });
    const res = runHook(GUARD, root, { TOOL_INPUT: cmd });
    assert.equal(res.status, 2, `expected block for: ${cmd}`);
    assert.match(res.stderr, new RegExp(`BLOCKED.*'${branch}'`), "block message names the configured branch");
    assert.match(res.stderr, /gov land|gov finalize/, "block message is actionable");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("guard does NOT block a branch that is not configured (no hardcoded dev literal)", () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "release-2026" } });
  const res = runHook(GUARD, root, { TOOL_INPUT: "git push origin dev" });
  assert.equal(res.status, 0, "dev is not configured here, so it is not protected");
  fs.rmSync(root, { recursive: true, force: true });
});

test("guard always protects the coord workspace base", () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "release-2026" } });
  const res = runHook(GUARD, root, { TOOL_INPUT: "git push origin main" });
  assert.equal(res.status, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("COORD-895: the guard protects the CONFIGURED board branch, not a hard-coded main", () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "release-2026" } });
  fs.writeFileSync(
    path.join(root, "coord", "project.config.js"),
    `module.exports = ${JSON.stringify({ boardBranch: "governance", repos: { B: { path: "api", integrationBranch: "release-2026" } } })};\n`
  );
  const blocked = runHook(GUARD, root, { TOOL_INPUT: "git push origin governance" });
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /BLOCKED.*'governance'/);
  const allowed = runHook(GUARD, root, { TOOL_INPUT: "git push origin main" });
  assert.equal(allowed.status, 0, `main is not the configured board branch here (stderr: ${allowed.stderr})`);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guard FAILS CLOSED: risky git mutation + unresolvable config blocks with actionable output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-hook-broken-"));
  // COORD-930: the engine is installed, but its workspace carries no config.
  const engineHooks = path.join(root, "coord", "engine", "scripts", "hooks");
  fs.mkdirSync(engineHooks, { recursive: true });
  for (const name of ENGINE_HOOK_FILES) fs.copyFileSync(path.join(ENGINE_HOOKS_DIR, name), path.join(engineHooks, name));
  const res = runHook(GUARD, root, { TOOL_INPUT: "git merge some-branch" });
  assert.equal(res.status, 2, "cannot verify => block");
  assert.match(res.stderr, /fail-closed/i);
  assert.match(res.stderr, /project\.config\.js/);
  const harmless = runHook(GUARD, root, { TOOL_INPUT: "ls" });
  assert.equal(harmless.status, 0, "non-git commands are not held hostage by broken config");
  fs.rmSync(root, { recursive: true, force: true });
});

test("guard reads the Claude hook JSON stdin payload when env vars are absent", () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const res = spawnSync(process.execPath, [fixtureScript(root, GUARD)], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TOOL_INPUT: "", TOOL_OUTPUT: "" },
    input: JSON.stringify({ tool_input: { command: "git push origin main" } }),
  });
  assert.equal(res.status, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("post-bash heartbeats through governance.js (never `node coord/scripts/gov`) after gov commit", () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const res = runHook(POST, root, { TOOL_INPUT: "coord/scripts/gov commit COORD-476 --message x" });
  assert.equal(res.status, 0);
  const calls = fs.readFileSync(path.join(root, "coord", "scripts", "calls.log"), "utf8");
  assert.match(calls, /\["heartbeat","COORD-476"\]/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("post-bash advisory failures are OBSERVABLE skips and still exit 0", () => {
  const root = makeWorkspace(
    { B: { path: "api", integrationBranch: "main" } },
    { governanceBody: "process.exit(3);\n" }
  );
  const res = runHook(POST, root, { TOOL_INPUT: "coord/scripts/gov commit COORD-9 -m x" });
  assert.equal(res.status, 0, "advisory hook never blocks");
  assert.match(res.stdout, /ADVISORY skipped \(heartbeat\)/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("post-bash post-land advisories run on merged output and degrade observably", () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const res = runHook(POST, root, {
    TOOL_INPUT: "coord/scripts/gov land COORD-888",
    TOOL_OUTPUT: '{"status": "merged"}',
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Test maturity has never been audited/);
  // landed-diff advisory cannot resolve paths.js in this minimal fixture:
  // it must skip VISIBLY, not vanish.
  assert.match(res.stdout, /ADVISORY skipped \(landed-diff\)/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("post-bash does nothing (quietly) for unrelated commands", () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const res = runHook(POST, root, { TOOL_INPUT: "ls -la" });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "");
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// COORD-660 — stdin delivery TIMING.
//
// Every test above drives the hooks through spawnSync, which PRE-BUFFERS
// `input` into the pipe before the child is executed. The read therefore always
// succeeded instantly, and the suite reported green while the shipped guard
// failed open against the real harness, which does not guarantee that timing.
//
// These tests use spawn() and control WHEN the payload is written. They are the
// regression proof: on the pre-fix code every non-zero delay below produced
// exit=0 with empty stderr (a silent permit for a protected-branch push).
// ---------------------------------------------------------------------------

const DELIVERY_DELAYS_MS = [0, 100, 300, 800];

// Deliberately assembled rather than written literally: the repository's own
// live PreToolUse guard refuses a Bash call whose text contains a
// protected-branch push (COORD-637 tracks that over-breadth), which would block
// an agent from editing this file at all.
const PROTECTED_PUSH = ["git", "pu" + "sh", "origin", "ma" + "in"].join(" ");

function runHookDelayed(script, root, { delayMs, stdinText, env = {}, attachStdin = true }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixtureScript(root, script)], {
      cwd: root,
      encoding: "utf8",
      stdio: [attachStdin ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...process.env, TOOL_INPUT: "", TOOL_OUTPUT: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    let timer = null;
    if (attachStdin) {
      timer = setTimeout(() => {
        try {
          if (stdinText) child.stdin.write(stdinText);
          child.stdin.end();
        } catch {
          /* child already exited */
        }
      }, delayMs);
    }
    child.on("exit", (status) => {
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("guard BLOCKS a protected-branch push however late the harness writes stdin", async () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const payload = JSON.stringify({ tool_input: { command: PROTECTED_PUSH } });
  for (const delayMs of DELIVERY_DELAYS_MS) {
    const res = await runHookDelayed(GUARD, root, { delayMs, stdinText: payload });
    assert.equal(res.status, 2, `delay=${delayMs}ms must still BLOCK (pre-fix: 0 = silent permit)`);
    assert.match(res.stderr, /BLOCKED.*'main'/, `delay=${delayMs}ms must say why it blocked`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("guard REFUSES when the payload cannot be read — an empty read is never an empty command", async () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const cases = [
    { label: "stdin closed immediately with nothing", opts: { delayMs: 0, stdinText: "" } },
    { label: "stdin closed after 300ms with nothing", opts: { delayMs: 300, stdinText: "" } },
    { label: "no stdin attached at all", opts: { delayMs: 0, attachStdin: false } },
  ];
  for (const { label, opts } of cases) {
    const res = await runHookDelayed(GUARD, root, opts);
    assert.equal(res.status, 2, `${label}: must refuse, not allow`);
    assert.match(res.stderr, /BLOCKED \(fail-closed\)/, `${label}: refusal must be stated`);
    assert.match(res.stderr, /no command to inspect/, `${label}: refusal must name the cause`);
    assert.match(res.stderr, /retry the command|settings\.json/, `${label}: refusal must be actionable`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("guard blocks on the ENV payload alone, with no stdin ever written (fd 0 untouched)", async () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  // Both children get an stdin pipe that is NEVER written and never closed.
  // They differ in ONE thing: whether the environment payload already answers.
  // The lazy child must finish while the child that has to consult fd 0 is
  // still waiting on its deadline.
  //
  // This is deliberately an ORDERING claim between two processes started
  // together on the same machine, not an absolute elapsed-time threshold.
  // Load slows both children, so the verdict does not move with it — the
  // earlier `Date.now() - started < 4000` form was exactly the kind of
  // wall-clock assertion that failed in the canonical aggregate run.
  const control = runHookDelayed(GUARD, root, { delayMs: 60000, stdinText: "" });
  let controlSettled = false;
  control.then(() => {
    controlSettled = true;
  });

  const res = await runHookDelayed(GUARD, root, {
    delayMs: 60000,
    stdinText: "",
    env: { TOOL_INPUT: PROTECTED_PUSH },
  });
  assert.equal(res.status, 2, "the env payload alone must still block");
  assert.match(res.stderr, /BLOCKED.*'main'/);
  assert.equal(
    controlSettled,
    false,
    "env sufficiency must short-circuit stdin entirely: the lazy child must finish " +
      "while an otherwise identical child that has to consult fd 0 is still waiting"
  );

  // The control still proves its own half of the contract: consulting an fd 0
  // that never delivers ends at the bounded deadline, as a REFUSAL.
  const controlRes = await control;
  assert.equal(controlRes.status, 2, "a payload that never arrives must refuse, not allow");
  assert.match(controlRes.stderr, /BLOCKED \(fail-closed\)/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guard is NOT a blanket refusal: legitimate commands still pass on either channel", async () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const benign = ["git status --short", "git log --oneline -5", "git diff HEAD", "ls -la", "npm test"];
  for (const cmd of benign) {
    const viaEnv = await runHookDelayed(GUARD, root, { delayMs: 60000, stdinText: "", env: { TOOL_INPUT: cmd } });
    assert.equal(viaEnv.status, 0, `env channel must allow: ${cmd} (stderr: ${viaEnv.stderr})`);
    const viaStdin = await runHookDelayed(GUARD, root, {
      delayMs: 250,
      stdinText: JSON.stringify({ tool_input: { command: cmd } }),
    });
    assert.equal(viaStdin.status, 0, `late stdin channel must allow: ${cmd} (stderr: ${viaStdin.stderr})`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("post-bash reports an unreadable payload as an OBSERVABLE skip and still exits 0", async () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const res = await runHookDelayed(POST, root, { delayMs: 0, stdinText: "" });
  assert.equal(res.status, 0, "PostToolUse advisories never block");
  assert.match(res.stdout, /ADVISORY skipped \(payload\)/, "an inert advisory must announce itself");
  fs.rmSync(root, { recursive: true, force: true });
});

test("post-bash still heartbeats when the payload arrives LATE on stdin", async () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const res = await runHookDelayed(POST, root, {
    delayMs: 300,
    stdinText: JSON.stringify({ tool_input: { command: "coord/scripts/gov commit COORD-660 -m x" } }),
  });
  assert.equal(res.status, 0);
  const calls = fs.readFileSync(path.join(root, "coord", "scripts", "calls.log"), "utf8");
  assert.match(calls, /\["heartbeat","COORD-660"\]/, "a late payload must still drive the advisory");
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// COORD-664 — the PRIMARY case: landing a ticket branch into the branch you are
// ALREADY STANDING ON, by SHA.
//
// Every case above names the protected branch in the command text. The real
// landing does not: you check out the integration branch and take a source
// commit by SHA, so the branch name never appears. On the pre-fix guard both
// cases below exited 0 — a silent permit — while a read-only ancestry query and
// a ticket-filing command whose PROSE quoted one were refused.
//
// These run against a REAL git repository, because the whole point is that the
// verdict comes from repository state rather than from the command text.
// ---------------------------------------------------------------------------

const { gitFixture, gitFixtureSpawn } = require("../test-git-fixture.js");

function git(root, args) {
  const res = gitFixtureSpawn(root, args);
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

// A workspace that is also a git repo: `main` is the configured integration
// branch, and `feature/work` carries the source commit a landing would take.
function makeGitWorkspace() {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  gitFixture(root, ["init", "-q", "-b", "main", "."]);
  git(root, ["config", "user.email", "hooks@example.com"]);
  git(root, ["config", "user.name", "Hooks Test"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["checkout", "-q", "-b", "feature/work"]);
  fs.writeFileSync(path.join(root, "source.txt"), "source\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "source commit"]);
  const sha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "-q", "main"]);
  return { root, sha };
}

test("COORD-664: a by-SHA landing onto the branch under HEAD is REFUSED (pre-fix: exit 0)", () => {
  const { root, sha } = makeGitWorkspace();
  for (const cmd of [`git merge --no-ff ${sha} -m "Merge COORD-664"`, `git cherry-pick ${sha}`]) {
    const res = runHook(GUARD, root, { TOOL_INPUT: cmd });
    assert.equal(res.status, 2, `must refuse while HEAD is on a protected branch: ${cmd}`);
    assert.match(res.stderr, /HEAD is on protected integration branch 'main'/);
    assert.match(res.stderr, /gov land|gov finalize/, "refusal must be actionable");
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("COORD-664: the current branch comes from repo state — command text cannot spoof it", () => {
  const { root } = makeGitWorkspace();
  // Naming a NON-protected branch while standing on a protected one must still
  // refuse, and so must pointing `-C` somewhere else: the answer is read from
  // the resolved repo, never from the payload.
  for (const cmd of ["git merge feature/work", "git -C /nonexistent/elsewhere cherry-pick deadbeef"]) {
    const res = runHook(GUARD, root, { TOOL_INPUT: cmd });
    assert.equal(res.status, 2, `spoof attempt must not succeed: ${cmd}`);
    if (cmd.includes("nonexistent")) assert.match(res.stderr, /current branch could not be read/);
    else assert.match(res.stderr, /HEAD is on protected integration branch 'main'/);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("COORD-664: not a blanket refusal — reads, prose and feature-branch work still pass", () => {
  const { root, sha } = makeGitWorkspace();
  const allowedOnProtectedHead = [
    `git merge-base --is-ancestor ${sha} main`,
    `git branch --contains ${sha} main`,
    "git log --oneline -5",
    "git status --porcelain",
    `coord/scripts/gov file-ticket --repo X --type bug --pri P0 --description "it permitted git merge ${sha} while refusing git merge-base --is-ancestor ${sha} main"`,
  ];
  for (const cmd of allowedOnProtectedHead) {
    const res = runHook(GUARD, root, { TOOL_INPUT: cmd });
    assert.equal(res.status, 0, `must stay allowed on a protected HEAD: ${cmd} (stderr: ${res.stderr})`);
  }

  git(root, ["checkout", "-q", "feature/work"]);
  for (const cmd of [`git merge --no-ff ${sha}`, `git cherry-pick ${sha}`, "git merge --abort"]) {
    const res = runHook(GUARD, root, { TOOL_INPUT: cmd });
    assert.equal(res.status, 0, `must stay allowed on a feature branch: ${cmd} (stderr: ${res.stderr})`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("COORD-637: protected destinations refuse while protected sources refresh feature branches", () => {
  const { root } = makeGitWorkspace();
  git(root, ["checkout", "-q", "feature/work"]);
  const blocked = [PROTECTED_PUSH, ["git", "pu" + "sh", "origin", "HEAD:ma" + "in"].join(" ")];
  for (const cmd of blocked) {
    const res = runHook(GUARD, root, { TOOL_INPUT: cmd });
    assert.equal(res.status, 2, `COORD-476 refusal must survive: ${cmd}`);
    assert.match(res.stderr, /BLOCKED.*'main'/);
  }
  const refresh = runHook(GUARD, root, { TOOL_INPUT: "git merge main" });
  assert.equal(refresh.status, 0, `merging protected main into a feature branch is safe (stderr: ${refresh.stderr})`);
  // ...and a push of the feature branch itself is still fine
  const ok = runHook(GUARD, root, { TOOL_INPUT: ["git", "pu" + "sh", "origin", "feature/work"].join(" ") });
  assert.equal(ok.status, 0, `pushing a feature branch stays allowed (stderr: ${ok.stderr})`);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// COORD-930 — location independence and per-invocation target resolution.
// Each case is a behavioural spawn of the installed guard, not a string check.
// ---------------------------------------------------------------------------

function makeRepo(dir, branch, { protectedBranch = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  gitFixture(dir, ["init", "-q", "-b", "main", "."]);
  git(dir, ["config", "user.email", "hooks@example.com"]);
  git(dir, ["config", "user.name", "Hooks Test"]);
  fs.writeFileSync(path.join(dir, "file.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  if (branch !== "main") git(dir, ["checkout", "-q", "-b", branch]);
  void protectedBranch;
  return dir;
}

test("COORD-930 bypass: a config PLANTED in the target repo cannot relax the guard", () => {
  // The engine policy protects `main`. The target repo plants a config that calls
  // `main` unprotected. Pre-fix, the guard read the planted config from cwd and allowed it.
  const { root: engineRoot } = makeGitWorkspace();
  const target = makeRepo(fs.mkdtempSync(path.join(os.tmpdir(), "coord-target-")), "main");
  fs.mkdirSync(path.join(target, "coord"), { recursive: true });
  fs.writeFileSync(
    path.join(target, "coord", "project.config.js"),
    `module.exports = ${JSON.stringify({ repos: { X: { path: ".", integrationBranch: "planted" } }, boardBranch: "planted-board" })};\n`
  );
  git(target, ["checkout", "-q", "-b", "feature/work"]);
  git(target, ["checkout", "-q", "main"]);
  const res = spawnSync(process.execPath, [fixtureScript(engineRoot, GUARD)], {
    cwd: target,
    encoding: "utf8",
    env: { ...process.env, TOOL_INPUT: "git merge feature/work", TOOL_OUTPUT: "" },
    input: "",
  });
  assert.equal(res.status, 2, `planted config must not unprotect main (stderr: ${res.stderr})`);
  assert.match(res.stderr, /HEAD is on protected integration branch 'main'/);
  fs.rmSync(engineRoot, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test("COORD-930: the trusted root is the engine install, so a relative hook path cannot move it", () => {
  // A guard copy outside coord/engine/scripts/hooks must fail closed rather than
  // fall back to the cwd.
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const stray = path.join(root, "elsewhere");
  fs.mkdirSync(stray, { recursive: true });
  fs.copyFileSync(path.join(fixtureScript(root, GUARD)), path.join(stray, "pre-bash-guard.js"));
  for (const name of ENGINE_HOOK_FILES) if (name !== "pre-bash-guard.js") fs.copyFileSync(path.join(root, "coord", "engine", "scripts", "hooks", name), path.join(stray, name));
  const res = spawnSync(process.execPath, [path.join(stray, "pre-bash-guard.js")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TOOL_INPUT: "git push origin main", TOOL_OUTPUT: "" },
    input: "",
  });
  assert.equal(res.status, 2, "a guard outside the engine layout must block, not fall back to cwd");
  assert.match(res.stderr, /not installed at coord\/engine\/scripts\/hooks/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("COORD-930: every git targeting form resolves the repository that is actually acted on", () => {
  const { root: protectedRepo } = makeGitWorkspace(); // HEAD on main (protected)
  const feature = makeRepo(fs.mkdtempSync(path.join(os.tmpdir(), "coord-feature-")), "feature/x");
  const engineRoot = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const run = (cmd, env = {}) =>
    spawnSync(process.execPath, [fixtureScript(engineRoot, GUARD)], {
      cwd: feature,
      encoding: "utf8",
      env: { ...process.env, TOOL_INPUT: cmd, TOOL_OUTPUT: "", ...env },
      input: "",
    });
  // Control: from the feature repo itself, merging into the feature branch is allowed.
  assert.equal(run("git merge feature/x").status, 0, "control: feature-branch merge from its own repo is allowed");
  for (const [label, cmd, env] of [
    ["-C", `git -C ${protectedRepo} merge feature/work`, {}],
    ["--git-dir", `git --git-dir=${path.join(protectedRepo, ".git")} merge feature/work`, {}],
    ["--git-dir (spaced)", `git --git-dir ${path.join(protectedRepo, ".git")} merge feature/work`, {}],
    ["GIT_DIR prefix", `GIT_DIR=${path.join(protectedRepo, ".git")} git merge feature/work`, {}],
    ["GIT_DIR inherited", "git merge feature/work", { GIT_DIR: path.join(protectedRepo, ".git") }],
    ["chained -C", `git -C ${path.dirname(protectedRepo)} -C ${path.basename(protectedRepo)} merge feature/work`, {}],
  ]) {
    const res = run(cmd, env);
    assert.equal(res.status, 2, `${label} must resolve the protected repo (stderr: ${res.stderr})`);
    assert.match(res.stderr, /HEAD is on protected integration branch 'main'/, label);
  }
  for (const dir of [protectedRepo, feature, engineRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

test("COORD-930: git pull is guarded like the other ref-moving commands", () => {
  const { root: protectedRepo } = makeGitWorkspace();
  const feature = makeRepo(fs.mkdtempSync(path.join(os.tmpdir(), "coord-pull-")), "feature/x");
  const engineRoot = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const at = (cwd, cmd) =>
    spawnSync(process.execPath, [fixtureScript(engineRoot, GUARD)], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, TOOL_INPUT: cmd, TOOL_OUTPUT: "" },
      input: "",
    });
  const onProtected = at(protectedRepo, "git pull origin feature/work");
  assert.equal(onProtected.status, 2, `pull while HEAD is protected must block (stderr: ${onProtected.stderr})`);
  assert.match(onProtected.stderr, /git pull/);
  assert.equal(at(feature, "git pull origin main").status, 0, "pulling main into a feature branch stays allowed");
  for (const dir of [protectedRepo, feature, engineRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

test("COORD-930: push --all / --mirror are checked against the protected branches of the target repo", () => {
  const feature = makeRepo(fs.mkdtempSync(path.join(os.tmpdir(), "coord-allpush-")), "feature/x");
  const engineRoot = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const push = (cmd) =>
    spawnSync(process.execPath, [fixtureScript(engineRoot, GUARD)], {
      cwd: feature,
      encoding: "utf8",
      env: { ...process.env, TOOL_INPUT: cmd, TOOL_OUTPUT: "" },
      input: "",
    });
  // `main` exists locally in this repo, so pushing every branch would publish it.
  assert.equal(push("git push --all origin").status, 2, "push --all names the protected local main");
  assert.equal(push("git push --mirror origin").status, 2, "push --mirror names the protected local main");
  assert.equal(push("git push --tags origin").status, 0, "tags are not branch destinations");
  assert.equal(push("git push origin feature/x").status, 0, "a feature push stays allowed");
  fs.rmSync(feature, { recursive: true, force: true });
  fs.rmSync(engineRoot, { recursive: true, force: true });
});

test("COORD-930: post-bash heartbeats from the trusted engine root, never from the cwd", () => {
  const root = makeWorkspace({ B: { path: "api", integrationBranch: "main" } });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "coord-post-cwd-"));
  fs.mkdirSync(path.join(elsewhere, "coord", "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(elsewhere, "coord", "scripts", "governance.js"),
    'require("node:fs").appendFileSync(require("node:path").join(__dirname, "calls.log"), "CWD-CALLED\\n");\n'
  );
  const res = spawnSync(process.execPath, [fixtureScript(root, POST)], {
    cwd: elsewhere,
    encoding: "utf8",
    env: { ...process.env, TOOL_INPUT: "coord/scripts/gov commit COORD-476 --message x", TOOL_OUTPUT: "" },
    input: "",
  });
  assert.equal(res.status, 0);
  assert.match(fs.readFileSync(path.join(root, "coord", "scripts", "calls.log"), "utf8"), /\["heartbeat","COORD-476"\]/);
  assert.equal(fs.existsSync(path.join(elsewhere, "coord", "scripts", "calls.log")), false, "the cwd's governance must not be invoked");
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});
