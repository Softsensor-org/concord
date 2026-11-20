"use strict";

// COORD-856: every command an engine message prints for an operator to copy
// quotes each interpolated path with the one git-ops shellQuote helper. These
// checks parse the printed text with a POSIX shell-word splitter (cross-checked
// against /bin/sh) and assert the argv a paste would run.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { shellQuote, formatGitCommand } = require(require("../paths.js").resolveEngineModule(path.resolve(__dirname, ".."), "scripts/git-ops.js"));
const { HOSTILE_PATH_SEGMENT, hostileTempDir, splitPosixCommands, splitPosixShellWords, shellArgv } = require("./fixtures/posix-shell-words.js");
const { CONTROL_PLANE_TOPOLOGY, controlPlaneRepoUnavailableMessage } = require(require("../paths.js").resolveEngineModule(path.resolve(__dirname, ".."), "scripts/control-plane-paths.js"));

function assertArgv(command, expected) {
  assert.deepEqual(splitPosixShellWords(command), expected, command);
  assert.deepEqual(shellArgv(command), expected, `/bin/sh agrees: ${command}`);
}

test("COORD-856: the shell-word splitter agrees with /bin/sh and refuses what a shell would act on", () => {
  for (const [text, argv] of [
    ["git -C /a/b fetch origin", ["git", "-C", "/a/b", "fetch", "origin"]],
    ["git -C '/a b/(c) $d' init", ["git", "-C", "/a b/(c) $d", "init"]],
    ["echo 'it'\\''s' \"x\\$y\" a\\ b", ["echo", "it's", "x$y", "a b"]],
    ["echo \"a\\\nb\" c\\\nd", ["echo", "ab", "cd"]],
  ]) {
    assertArgv(text, argv);
  }
  assert.deepEqual(splitPosixCommands("git -C 'a b' checkout -- . && git -C 'a b' clean -fd"),
    [["git", "-C", "a b", "checkout", "--", "."], ["git", "-C", "a b", "clean", "-fd"]]);
  for (const unsafe of ["git -C /a b(c) init", "git -C /a$HOME init", "echo `id`", "a; b", "a | b", "a > b", "a & b", "ls *",
    "cd ~", "x #c", "echo \"$HOME\"", "echo 'open", "echo \"open", "echo x\\", "&& a", "a &&"]) {
    assert.throws(() => splitPosixCommands(unsafe), Error, unsafe);
  }
  assert.throws(() => splitPosixShellWords("a && b"), /expected one simple command, found 2/);
  assert.throws(() => shellArgv("echo 'open"), /could not tokenize/);
});

test("COORD-856: shellQuote leaves shell-safe words alone and makes any other word one literal word", () => {
  for (const safe of ["/tmp/plain-dir_1/x.y", "backend", "origin/dev", "user@host:path,a=b+c%d", "-fd"]) {
    assert.equal(shellQuote(safe), safe, "an ordinary word prints exactly as before");
  }
  const hostile = `/tmp/${HOSTILE_PATH_SEGMENT}end`;
  for (const word of [hostile, "", "a'b", "''", "x\ny", "~user", "#hash", "a\\b", "`id`", "*"]) {
    assertArgv(`printf ${shellQuote(word)}`, ["printf", word]);
  }
  assert.equal(shellQuote(""), "''", "an empty word is still a word");
  assert.equal(shellQuote(42), "42");
  assertArgv(formatGitCommand(hostile, ["reset", "--keep", "a".repeat(40)]), ["git", "-C", hostile, "reset", "--keep", "a".repeat(40)]);
  assert.equal(formatGitCommand("/tmp/x"), "git -C /tmp/x", "args default to none");
});

test("COORD-856: the control-plane git init advice quotes coord/ in both topologies", (t) => {
  const base = hostileTempDir("control-plane");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const coordDir = path.join(base, "coord");
  for (const topology of [CONTROL_PLANE_TOPOLOGY.FOREIGN_ANCESTOR, CONTROL_PLANE_TOPOLOGY.NONE]) {
    const message = controlPlaneRepoUnavailableMessage({ topology, coordDir }, "gov sync");
    const printed = /(git -C .+ init)(?:\)| so|\. )/.exec(message);
    assert.ok(printed, message);
    assertArgv(printed[1], ["git", "-C", coordDir, "init"]);
  }
  assert.match(controlPlaneRepoUnavailableMessage({ topology: CONTROL_PLANE_TOPOLOGY.NONE, coordDir }),
    /^Control-plane Git operations require a control-plane Git repository/, "the default action wording");
});
