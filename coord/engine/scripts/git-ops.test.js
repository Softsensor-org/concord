"use strict";

// COORD-985: gitOrNull is the null-on-failure policy shared by engine modules that treat a
// failed git call as "no answer" (run-manifest, test-policy-schedule, review-workspace-evidence).
// It must return the untrimmed stdout on success and null on any non-zero exit, and it must
// pass options (maxBuffer, timeout) through to the same spawn gitTry makes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitOrNull, gitTry } = require("./git-ops.js");
const { gitFixture } = require("./test-git-fixture.js");

function makeRepo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord985-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  gitFixture(dir, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  gitFixture(dir, ["add", "a.txt"]);
  gitFixture(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"]);
  return dir;
}

test("COORD-985 gitOrNull returns the untrimmed stdout of a successful git call", (t) => {
  const repo = makeRepo(t);
  const out = gitOrNull(repo, ["rev-parse", "HEAD"]);
  assert.equal(typeof out, "string");
  assert.equal(out, `${gitFixture(repo, ["rev-parse", "HEAD"])}\n`);
});

test("COORD-985 gitOrNull returns null when git exits non-zero, matching the old local helper", (t) => {
  const repo = makeRepo(t);
  assert.equal(gitOrNull(repo, ["rev-parse", "--verify", "no-such-ref"]), null);
});

test("COORD-985 gitOrNull returns null for a directory that is not a repository", (t) => {
  const notRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord985-norepo-")));
  t.after(() => fs.rmSync(notRepo, { recursive: true, force: true }));
  assert.equal(gitOrNull(notRepo, ["rev-parse", "HEAD"]), null);
});

test("COORD-985 gitOrNull forwards options such as maxBuffer to the same spawn gitTry uses", (t) => {
  const repo = makeRepo(t);
  const viaTry = gitTry(repo, ["show", "HEAD:a.txt"], { maxBuffer: 256 * 1024 * 1024 });
  assert.equal(gitOrNull(repo, ["show", "HEAD:a.txt"], { maxBuffer: 256 * 1024 * 1024 }), viaTry.stdout);
});
