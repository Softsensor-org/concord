"use strict";

// COORD-476 / COORD-618 — static regression tests for the donor-only retired
// init.sh guidance shim and generated Claude hooks.
//
//   1. Static bans: `grep -P`/`-oP`, `node coord/scripts/gov` (the Bash
//      shim), hardcoded `origin/dev`, and Bash-4 `declare -A` are rejected in
//      every shipped hook/bootstrap surface.
//   2. /bin/sh compatibility: every generated hook command and init.sh parse
//      under `sh -n`.
//   3. Retirement: POSIX sh and stock macOS Bash invocations both refuse every
//      old install form, name npm/SEA plus manual recovery, and write nothing.
//   4. Product repo safety: repo HEAD and the backend/frontend working trees
//      are byte-for-byte untouched by these tests.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SETTINGS_PATH = path.join(REPO_ROOT, ".claude", "settings.json");
const INIT_SH = path.join(REPO_ROOT, "init.sh");
const INIT_PRESENT = fs.existsSync(INIT_SH);

// Constructed patterns (kept out of literal source so this file does not
// trip its own scan if it is ever added to the scanned surface).
const BANNED = [
  { name: "GNU grep -P/-oP", pattern: new RegExp("\\bgrep\\s+-[a-zA-Z]*" + "P") },
  { name: "node run of the gov Bash shim", pattern: new RegExp("\\bnode\\s+(?:\\./)?coord/scripts/" + "gov(?![A-Za-z0-9_.-])") },
  { name: "hardcoded origin/dev", pattern: new RegExp("\\borigin/" + "dev\\b") },
  { name: "Bash 4 declare -A", pattern: new RegExp("\\bdeclare\\s+-[a-zA-Z]*" + "A") },
];

function hookCommands() {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  const commands = [];
  for (const groups of Object.values(settings.hooks || {})) {
    for (const group of groups) {
      for (const entry of group.hooks || []) {
        if (typeof entry.command === "string") commands.push(entry.command);
      }
    }
  }
  assert.ok(commands.length >= 5, "expected generated hook commands in .claude/settings.json");
  return commands;
}

function shippedSurfaces() {
  const surfaces = [
    { name: ".claude/settings.json", body: fs.readFileSync(SETTINGS_PATH, "utf8") },
  ];
  if (INIT_PRESENT) surfaces.push({ name: "init.sh", body: fs.readFileSync(INIT_SH, "utf8") });
  const commandsDir = path.join(REPO_ROOT, ".claude", "commands");
  for (const name of fs.readdirSync(commandsDir).filter((n) => n.endsWith(".md")).sort()) {
    surfaces.push({ name: `.claude/commands/${name}`, body: fs.readFileSync(path.join(commandsDir, name), "utf8") });
  }
  for (const name of fs.readdirSync(__dirname).filter((n) => n.endsWith(".js") && !n.endsWith(".test.js")).sort()) {
    surfaces.push({ name: `coord/scripts/hooks/${name}`, body: fs.readFileSync(path.join(__dirname, name), "utf8") });
  }
  return surfaces;
}

// ---- product-repo safety net -------------------------------------------------

function gitAt(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function productRepoState() {
  const head = gitAt(REPO_ROOT, ["rev-parse", "HEAD"]).stdout.trim();
  const status = gitAt(REPO_ROOT, ["status", "--porcelain", "--", "backend", "frontend"]).stdout;
  return `${head}\n${status}`;
}

const productStateBefore = productRepoState();

test("static bans: no GNU-only, shim-through-node, or hardcoded-origin/dev patterns in shipped surfaces", () => {
  for (const surface of shippedSurfaces()) {
    for (const { name, pattern } of BANNED) {
      assert.equal(
        pattern.test(surface.body),
        false,
        `${surface.name} contains banned pattern: ${name}`
      );
    }
  }
});

test("generated hook commands parse under /bin/sh (sh -n)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-shn-"));
  hookCommands().forEach((command, i) => {
    const file = path.join(dir, `hook-${i}.sh`);
    fs.writeFileSync(file, `${command}\n`);
    const res = spawnSync("sh", ["-n", file], { encoding: "utf8" });
    assert.equal(res.status, 0, `hook command ${i} is not /bin/sh-parseable: ${command}\n${res.stderr}`);
  });
  if (INIT_PRESENT) {
    const initCheck = spawnSync("sh", ["-n", INIT_SH], { encoding: "utf8" });
    assert.equal(initCheck.status, 0, `init.sh is not /bin/sh-parseable: ${initCheck.stderr}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("donor-only init.sh avoids Bash-only constructs entirely", { skip: !INIT_PRESENT && "release cuts intentionally omit init.sh" }, () => {
  const body = fs.readFileSync(INIT_SH, "utf8");
  assert.match(body.split("\n")[0], /^#!\/bin\/sh/);
  for (const construct of ["declare ", "mapfile", "readarray", "[[", "pipefail", "${BASH_SOURCE"]) {
    assert.equal(body.includes(construct), false, `init.sh must not use: ${construct}`);
  }
});

test("required safety hooks do not swallow failures (fail-closed wiring)", () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  const preToolUse = settings.hooks.PreToolUse || [];
  const guardCommands = preToolUse.flatMap((g) => (g.hooks || []).map((h) => h.command));
  assert.ok(guardCommands.length > 0, "PreToolUse safety hooks must exist");
  for (const command of guardCommands) {
    assert.equal(command.includes("|| true"), false, `safety hook must not fail open: ${command}`);
    assert.equal(command.includes("2>/dev/null"), false, `safety hook must not hide errors: ${command}`);
  }
});

test("advisory hook skips are wired to be observable", () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  const postToolUse = settings.hooks.PostToolUse || [];
  for (const group of postToolUse) {
    for (const entry of group.hooks || []) {
      assert.equal(entry.command.endsWith("|| true"), false, `advisory skip must stay visible: ${entry.command}`);
      assert.match(entry.command, /ADVISORY|post-bash\.js/, `advisory hook lacks observable skip: ${entry.command}`);
    }
  }
});

test("no generated hook rebases after gov start (base selection stays governed)", () => {
  for (const command of hookCommands()) {
    assert.equal(/git\s+rebase/.test(command), false, `post-start rebase hooks were removed by COORD-476: ${command}`);
  }
});

// ---- retired entry point ----------------------------------------------------

function assertRetiredInit(shell, args) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-retired-init-"));
  const before = fs.readdirSync(root);
  const res = spawnSync(shell, [INIT_SH, ...args], { cwd: root, encoding: "utf8" });
  assert.equal(res.status, 2, `${shell} unexpectedly accepted retired init.sh:\n${res.stderr}`);
  assert.match(res.stderr, /init\.sh is retired/);
  assert.match(res.stderr, /npx create-concord/);
  assert.match(res.stderr, /concord init/);
  assert.match(res.stderr, /not a transactional installer/);
  assert.match(res.stderr, /performed no writes/);
  assert.deepEqual(fs.readdirSync(root), before, `${shell} invocation mutated the empty target`);
  fs.rmSync(root, { recursive: true, force: true });
}

test("donor POSIX sh retirement refuses legacy dry-run and apply forms without writes", { skip: !INIT_PRESENT && "release cuts intentionally omit init.sh" }, () => {
  assertRetiredInit("sh", ["--dry-run", "--repo", "B:api", "--project", "legacy"]);
  assertRetiredInit("sh", ["--apply-plan", "untrusted-digest", "--force"]);
});

test("donor stock macOS Bash-compatible retirement refuses every invocation without writes", { skip: !INIT_PRESENT && "release cuts intentionally omit init.sh" }, () => {
  assertRetiredInit("bash", []);
  assertRetiredInit("bash", ["--git-init", "--git-stage", "--git-baseline-commit"]);
});

test("product repo HEADs and working trees stayed untouched by hook tests", () => {
  assert.equal(productRepoState(), productStateBefore);
});
