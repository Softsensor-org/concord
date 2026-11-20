"use strict";

// COORD-952: shared git-fixture environment for test suites.
//
// A fixture repo must not inherit the host's global or system git configuration
// (commit signing, hooks path, autoDetach, aliases). Such settings change fixture
// commits and worktree behaviour, so a suite that passes on one workstation can fail
// on another. Every git invocation a test makes against a temp repo should use this
// environment. The suites listed in test-harness-guards.test.js must require it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

// COORD-998: default commit identity for fixture repos, so a fixture commit does not depend on a
// host user.name/user.email (global config is isolated below). Callers may still override it through
// options.env; the host process.env identity wins over these defaults only when a caller passes it.
const GIT_TEST_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "coord-test",
  GIT_AUTHOR_EMAIL: "coord-test@example.invalid",
  GIT_COMMITTER_NAME: "coord-test",
  GIT_COMMITTER_EMAIL: "coord-test@example.invalid",
});

const GIT_ISOLATION = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

// Returns a copy of the process environment with host git config removed.
// `extra` is merged last so a caller can still pin author/committer identity.
function gitFixtureEnv(extra = {}) {
  return { ...GIT_TEST_IDENTITY, ...process.env, ...GIT_ISOLATION, ...extra };
}

// Runs git in `cwd` with the isolated environment and returns trimmed stdout.
// Throws with stderr on a non-zero exit, so a fixture setup failure is loud.
function gitFixture(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", ...options, env: gitFixtureEnv(options.env) }).trim();
}

// Same as gitFixture but returns the spawn result instead of throwing.
function gitFixtureSpawn(cwd, args, options = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", ...options, env: gitFixtureEnv(options.env) });
}

// COORD-1042: a bare remote for fixtures that push or fetch. The directory is created under
// os.tmpdir() (its parent is the temp root, so callers can place sibling files beside it) and is
// initialised through gitFixture, so the bare repo inherits no host git config either.
function gitBareRemote(prefix = "coord-bare-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  gitFixture(dir, ["init", "-q", "--bare", "."]);
  return dir;
}

module.exports = { GIT_ISOLATION, GIT_TEST_IDENTITY, gitFixtureEnv, gitFixture, gitFixtureSpawn, gitBareRemote };
