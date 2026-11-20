"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { checkGitPrerequisite, compareGitVersions, main, parseGitVersion } = require("./git-prerequisite.js");

function probe(stdout, status = 0, stderr = "") {
  return () => ({ stdout, status, stderr });
}

test("COORD-902: Git version parsing accepts vendor suffixes and rejects malformed output", () => {
  assert.deepEqual(parseGitVersion("git version 2.38.0\n"), { major: 2, minor: 38, patch: 0 });
  assert.deepEqual(parseGitVersion("git version 2.38.0.windows.1"), { major: 2, minor: 38, patch: 0 });
  assert.equal(parseGitVersion("not git version 2.38.0"), null);
  assert.equal(parseGitVersion("unrelated\ngit version 2.38.0"), null);
  assert.equal(parseGitVersion("git version 2.38.0\nunrelated"), null);
  assert.equal(parseGitVersion(null), null);
  assert.equal(parseGitVersion(undefined), null);
  assert.equal(compareGitVersions({ major: 2, minor: 37, patch: 99 }, { major: 2, minor: 38, patch: 0 }), -1);
});

test("COORD-902: the prerequisite accepts Git 2.38.0 and newer", () => {
  for (const version of ["2.38.0", "2.38.1", "2.47.3", "3.0.0"]) {
    const result = checkGitPrerequisite({ probe: probe(`git version ${version}\n`) });
    assert.deepEqual(result, { ok: true, found: version, required: "2.38.0", diagnostic: null });
  }
});

test("COORD-902: Git 2.34 reproduction reports found and required versions", () => {
  const result = checkGitPrerequisite({ probe: probe("git version 2.34.1\n") });
  assert.equal(result.ok, false);
  assert.equal(result.found, "2.34.1");
  assert.match(result.diagnostic, /Git 2\.38\.0 or newer is required/);
  assert.match(result.diagnostic, /merge-tree --write-tree --no-messages/);
  assert.match(result.diagnostic, /found 2\.34\.1/);
});

test("COORD-902: unavailable or malformed Git output fails with a useful diagnostic", () => {
  for (const result of [
    checkGitPrerequisite({ probe: () => ({ status: 127, stdout: "", stderr: "git: not found" }) }),
    checkGitPrerequisite({ probe: probe("unexpected output\n") }),
    checkGitPrerequisite({ probe: () => { throw new Error("probe timeout"); } }),
    checkGitPrerequisite({ probe: () => { throw "non-Error failure"; } }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.found, null);
    assert.match(result.diagnostic, /found unavailable/);
  }
  assert.match(checkGitPrerequisite({ probe: () => { throw new Error("probe timeout"); } }).diagnostic, /probe timeout/);
  assert.match(checkGitPrerequisite({ probe: () => { throw "non-Error failure"; } }).diagnostic, /non-Error failure/);
  const spawnError = checkGitPrerequisite({ probe: () => ({
    status: null, stdout: "", stderr: "", error: { message: "spawn ENOENT" },
  }) });
  assert.match(spawnError.diagnostic, /found unavailable \(spawn ENOENT\)/);
  const signal = checkGitPrerequisite({ probe: () => ({ status: null, stdout: "", stderr: "", signal: "SIGTERM" }) });
  assert.match(signal.diagnostic, /found unavailable \(probe ended with SIGTERM\)/);
});

test("COORD-902: the shared CLI reports both success and refusal", () => {
  let stdout = "";
  let stderr = "";
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  process.stdout.write = (value) => { stdout += String(value); return true; };
  process.stderr.write = (value) => { stderr += String(value); return true; };
  try {
    assert.equal(main({ probe: probe("git version 2.38.0\n") }), 0);
    assert.match(stdout, /found 2\.38\.0; required 2\.38\.0/);
    stdout = "";
    assert.equal(main({ probe: probe("git version 2.34.1\n") }), 1);
    assert.match(stderr, /found 2\.34\.1/);
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
});

test("COORD-902: invoking the prerequisite module runs its CLI entrypoint", () => {
  const child = spawnSync(process.execPath, [require.resolve("./git-prerequisite.js")], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Git prerequisite OK: found \d+\.\d+\.\d+; required 2\.38\.0\./);
});
