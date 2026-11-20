"use strict";

// COORD-906: the engine side of the fast test-title precheck. These cases use
// a fake child process, so they hold in every cut: where release/ is absent the
// precheck is a no-op, and where it is present the engine hands the right
// files and manifest to release/suite-titles.js. The real check, end to end
// through gov commit, gov submit and the runner, is release/suite-titles.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const precheck = require("./test-title-precheck.js");

function root(t, { release = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord906-precheck-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (release) {
    fs.mkdirSync(path.join(dir, "release"));
    fs.writeFileSync(path.join(dir, "release", "suite-titles.js"), "\n");
    fs.writeFileSync(path.join(dir, "release", "suite-inventory.json"), "{}\n");
  }
  return dir;
}

function fakeSpawn(status = 0, stdout = "") {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status, stdout, stderr: "" };
  };
  return { spawn, calls };
}

test("COORD-906: without release tooling every precheck is a no-op that spawns nothing", (t) => {
  const dir = root(t, { release: false });
  const { spawn, calls } = fakeSpawn(1);
  assert.equal(precheck.available(dir), false);
  assert.equal(precheck.available(""), false);
  assert.match(precheck.runTitlePrecheck({ root: dir, files: ["a.test.js"], spawn }).skipped, /no release suite inventory/);
  assert.equal(precheck.commitTitlePrecheck({ root: dir, stagedFiles: ["a.test.js"], gitTry: () => assert.fail("no git"), tmpDir: os.tmpdir(), spawn }).ok, true);
  assert.equal(precheck.submitTitlePrecheck({ root: dir, base: "dev", spawn }).ok, true);
  assert.deepEqual(calls, []);
});

test("COORD-906: only test files are checked, with the node:test child context scrubbed", (t) => {
  const dir = root(t);
  const { spawn, calls } = fakeSpawn(0, "ok\n");
  assert.equal(precheck.runTitlePrecheck({ root: dir, files: ["README.md"], spawn }).skipped, "no test files changed");
  const previous = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = "child-v8";
  try {
    const result = precheck.runTitlePrecheck({ root: dir, files: ["README.md", "coord/a.test.js"], spawn });
    assert.deepEqual(result, { ok: true, output: "ok\n" });
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(1), ["check", "--", "coord/a.test.js"]);
  assert.equal(calls[0].options.cwd, dir);
  assert.equal(calls[0].options.env.NODE_TEST_CONTEXT, undefined);
});

test("COORD-906: a commit is checked against the manifest it will contain", (t) => {
  const dir = root(t);
  const seen = [];
  const spawn = (_command, args) => {
    const at = args.indexOf("--manifest");
    seen.push(at === -1 ? null : fs.readFileSync(args[at + 1], "utf8"));
    return { status: 0, stdout: "", stderr: "" };
  };
  const gitTry = (_root, args) => (args[1] === ":release/suite-inventory.json" ? { status: 0, stdout: "INDEX COPY\n" } : { status: 1 });
  precheck.commitTitlePrecheck({ root: dir, stagedFiles: ["coord/a.test.js"], gitTry, tmpDir: os.tmpdir(), spawn });
  precheck.commitTitlePrecheck({ root: dir, stagedFiles: ["coord/a.test.js", "release/suite-inventory.json"], gitTry, tmpDir: os.tmpdir(), spawn });
  precheck.commitTitlePrecheck({ root: dir, stagedFiles: ["coord/a.test.js"], gitTry: () => ({ status: 128 }), tmpDir: os.tmpdir(), spawn });
  assert.equal(precheck.commitTitlePrecheck({ root: dir, stagedFiles: ["notes.md"], gitTry, tmpDir: os.tmpdir(), spawn }).skipped, "no test files changed");
  assert.deepEqual(seen, ["INDEX COPY\n", null, null], "index copy unless the manifest is staged or untracked");
});

test("COORD-906: submit checks the ticket's changed tests since its base and refusal names the remedy", (t) => {
  const dir = root(t);
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args.slice(1)].join(" "));
    // Only the local base resolves: origin/dev is absent, so dev is used.
    if (command === "git") return { status: args.at(-1) === "dev^{commit}" ? 0 : 1 };
    return { status: 1, stdout: "unregistered title [\"x\"]\n", stderr: "", error: new Error("spawn note") };
  };
  const result = precheck.submitTitlePrecheck({ root: dir, base: "dev", spawn });
  assert.equal(result.ok, false);
  assert.ok(calls.some((call) => call.endsWith("check --changed dev --")), calls.join("\n"));
  assert.match(precheck.refusal("submit", result), /^submit refused: changed test titles are not registered for both editions\.\nunregistered title \["x"\]\nspawn note\nRegister them with the fix shown, then retry\.$/);
  assert.equal(precheck.submitTitlePrecheck({ root: dir, base: null, spawn }).ok, true);
});

test("COORD-906: submit warns and continues when neither origin/<base> nor <base> resolves", (t) => {
  const dir = root(t);
  const calls = [];
  const spawn = (command, args) => { calls.push(command); return { status: 1, stdout: "", stderr: "" }; };
  const result = precheck.submitTitlePrecheck({ root: dir, base: "dev", spawn });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, "ticket base unresolved");
  assert.match(result.warning, /neither origin\/dev nor dev resolves/);
  assert.deepEqual(calls, ["git", "git"], "no title check runs without a base");
});

test("COORD-906: a targeted run checks tracked test files and names the untracked probes it skips", (t) => {
  const dir = root(t);
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args.slice(1)].join(" "));
    if (command === "git") return { status: 0, stdout: "coord/tracked.test.js\0" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = precheck.runnerTitlePrecheck({ root: dir, files: ["coord/tracked.test.js", "coord/.probe.test.js"], spawn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.untracked, ["coord/.probe.test.js"]);
  assert.ok(calls.some((call) => call.endsWith("check -- coord/tracked.test.js")), calls.join("\n"));
  // Outside a Git checkout every test file is checked.
  const noGit = (command) => (command === "git" ? { status: 128 } : { status: 1, stdout: "bad\n", stderr: "" });
  assert.equal(precheck.runnerTitlePrecheck({ root: dir, files: ["coord/a.test.js"], spawn: noGit }).ok, false);
  assert.equal(precheck.runnerTitlePrecheck({ root: dir, files: ["coord/a.js"], spawn: noGit }).skipped, "no test files changed");
});
