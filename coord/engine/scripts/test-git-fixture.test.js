"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitFixtureEnv, gitFixture, GIT_ISOLATION } = require("./test-git-fixture.js");

test("gitFixtureEnv removes host global and system git config", () => {
  const env = gitFixtureEnv();
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.deepEqual(Object.keys(GIT_ISOLATION).sort(), ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM"]);
});

test("a fixture repo ignores a host global config that would break commits", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coord952-gitcfg-"));
  const hostGlobal = path.join(home, "gitconfig");
  // A host global config that would make commits fail if it were honoured.
  fs.writeFileSync(hostGlobal, "[commit]\n\tgpgsign = true\n[user]\n\tuseConfigOnly = true\n");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = hostGlobal;
  try {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coord952-repo-"));
    gitFixture(repo, ["init", "-b", "dev"]);
    gitFixture(repo, ["config", "user.email", "fixture@example.invalid"]);
    gitFixture(repo, ["config", "user.name", "Fixture"]);
    fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
    gitFixture(repo, ["add", "seed.txt"]);
    gitFixture(repo, ["commit", "-m", "seed"]);
    assert.equal(gitFixture(repo, ["log", "--format=%s", "-1"]), "seed");
    fs.rmSync(repo, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
