"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseGitHubRepo, validateArchiveEntries, validateArchiveLinks, sha256 } = require("./upgrade-release-source.js").__internals;

test("GitHub repository pins normalize HTTPS and SSH forms", () => {
  assert.strictEqual(parseGitHubRepo("https://github.com/Softsensor-org/concord"), "Softsensor-org/concord");
  assert.strictEqual(parseGitHubRepo("git@github.com:Softsensor-org/concord.git"), "Softsensor-org/concord");
  assert.throws(() => parseGitHubRepo("https://example.com/repo"), /unsupported/);
});

test("release archive paths reject absolute and traversal entries", () => {
  assert.deepStrictEqual(validateArchiveEntries("root/coord/a\nroot/README.md\n"), ["root/coord/a", "root/README.md"]);
  assert.throws(() => validateArchiveEntries("/etc/passwd\n"), /unsafe/);
  assert.throws(() => validateArchiveEntries("root/../outside\n"), /unsafe/);
  assert.throws(() => validateArchiveEntries(""), /empty/);
});

test("release archive links must remain inside the archive root", () => {
  assert.doesNotThrow(() => validateArchiveLinks("lrwxrwxrwx root/root 0 date root/examples/demo/coord/scripts -> ../../../coord/scripts\n"));
  assert.throws(() => validateArchiveLinks("lrwxrwxrwx root/root 0 date root/link -> ../../outside\n"), /escapes/);
  assert.throws(() => validateArchiveLinks("lrwxrwxrwx root/root 0 date root/link -> /etc/passwd\n"), /escapes/);
});

test("release byte digest is deterministic SHA-256", () => {
  assert.strictEqual(sha256(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
