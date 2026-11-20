"use strict";

// COORD-862 (COORD-516a): deterministic tree fingerprint primitive.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { treeFingerprint, encodeEntries, TreeFingerprintError, TREE_ALGO } = require("./tree-fingerprint.js");

function withTree(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord862-tree-"));
  try {
    for (const [relative, content] of files) {
      const absolute = path.join(root, ...relative.split("/"));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
      fs.chmodSync(absolute, 0o644);
    }
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("COORD-862: identical bytes give one digest regardless of creation order", () => {
  const files = [["b.txt", "two"], ["a/z.txt", "one"], ["a/b.txt", "zero"]];
  const first = withTree(files, (root) => treeFingerprint(root, { modes: true }));
  const second = withTree([...files].reverse(), (root) => treeFingerprint(root, { modes: true }));
  assert.equal(first.algo, TREE_ALGO);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.entries.map((entry) => entry.path), ["a/b.txt", "a/z.txt", "b.txt"]);
  assert.equal(first.entries[0].sha256, crypto.createHash("sha256").update("zero").digest("hex"));
  assert.equal(first.entries[0].size, 4);
  assert.equal(first.entries[0].mode, 0o644);
});

test("COORD-862: paths sort by raw UTF-8 bytes, not locale collation", () => {
  const result = withTree([["b", "1"], ["B", "2"], ["é", "3"], ["a.txt", "4"], ["a-b", "5"]], (root) => treeFingerprint(root, { modes: false }));
  assert.deepEqual(result.entries.map((entry) => entry.path), ["B", "a-b", "a.txt", "b", "é"]);
});

test("COORD-862: content, path and mode changes all change the digest", () => {
  const base = withTree([["x/y", "data"]], (root) => treeFingerprint(root, { modes: true }).digest);
  assert.notEqual(withTree([["x/y", "datA"]], (root) => treeFingerprint(root, { modes: true }).digest), base);
  assert.notEqual(withTree([["x/z", "data"]], (root) => treeFingerprint(root, { modes: true }).digest), base);
  const modeChanged = withTree([["x/y", "data"]], (root) => {
    fs.chmodSync(path.join(root, "x", "y"), 0o755);
    return treeFingerprint(root, { modes: true });
  });
  if (process.platform !== "win32") {
    assert.equal(modeChanged.entries[0].mode, 0o755);
    assert.notEqual(modeChanged.digest, base);
  }
  // With modes disabled the mode never reaches the digest.
  const a = withTree([["x/y", "data"]], (root) => treeFingerprint(root, { modes: false }).digest);
  const b = withTree([["x/y", "data"]], (root) => {
    fs.chmodSync(path.join(root, "x", "y"), 0o755);
    return treeFingerprint(root, { modes: false }).digest;
  });
  assert.equal(a, b);
});

test("COORD-938: the recorded mode is the Git mode, so umask does not change the digest", (t) => {
  if (process.platform === "win32") return t.skip("POSIX modes unavailable");
  const withMode = (mode) => withTree([["x/y", "data"]], (root) => {
    fs.chmodSync(path.join(root, "x", "y"), mode);
    return treeFingerprint(root, { modes: true });
  });
  // umask 0002 yields 0664 and umask 0022 yields 0644 for the same shipped file.
  const group = withMode(0o664);
  const plain = withMode(0o644);
  assert.equal(group.entries[0].mode, 0o644);
  assert.equal(group.digest, plain.digest);
  // Owner-execute selects the executable class; group/other execute bits do not.
  assert.equal(withMode(0o775).entries[0].mode, 0o755);
  assert.equal(withMode(0o775).digest, withMode(0o755).digest);
  assert.notEqual(withMode(0o755).digest, plain.digest);
});

test("COORD-862: length-prefixed records cannot collide across a path/content split", () => {
  const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const left = encodeEntries([{ path: "ab", mode: 0, size: 1, sha256: hash("c") }, { path: "d", mode: 0, size: 0, sha256: hash("") }]);
  const right = encodeEntries([{ path: "a", mode: 0, size: 2, sha256: hash("bc") }, { path: "d", mode: 0, size: 0, sha256: hash("") }]);
  assert.notEqual(left.digest, right.digest);
  // Empty directories contribute nothing; an empty tree still has a stable digest.
  const empty = withTree([], (root) => {
    fs.mkdirSync(path.join(root, "empty-dir"));
    return treeFingerprint(root);
  });
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.digest, encodeEntries([]).digest);
});

test("COORD-862: symlinks and non-directories are refused, exclusions are honored", (t) => {
  withTree([["a.txt", "1"]], (root) => {
    try {
      fs.symlinkSync(path.join(root, "a.txt"), path.join(root, "link"));
    } catch (error) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    assert.throws(() => treeFingerprint(root), (error) => error instanceof TreeFingerprintError &&
      error.code === "symlink_refused" && error.path === "link");
    const excluded = treeFingerprint(root, { exclude: (relative) => relative === "link" });
    assert.deepEqual(excluded.entries.map((entry) => entry.path), ["a.txt"]);
    assert.throws(() => treeFingerprint(path.join(root, "link")), /symlink root/);
  });
  withTree([["a.txt", "1"]], (root) => {
    assert.throws(() => treeFingerprint(path.join(root, "a.txt")), (error) => error.code === "not_a_directory");
    const fifo = spawnSync("mkfifo", [path.join(root, "pipe")]);
    if (fifo.status !== 0) return;
    assert.throws(() => treeFingerprint(root), (error) => error.code === "special_file_refused" && error.path === "pipe");
  });
});

test("COORD-862 review: names that are not valid UTF-8 keep their exact bytes", (t) => {
  const digestFor = (nameByte) => withTree([], (root) => {
    try {
      fs.writeFileSync(Buffer.concat([Buffer.from(`${root}/`), Buffer.from([nameByte, 0x61])]), "same");
    } catch (error) {
      return { skipped: error.code };
    }
    return treeFingerprint(root, { modes: false });
  });
  const left = digestFor(0xff);
  const right = digestFor(0xfe);
  if (left.skipped || right.skipped) {
    t.skip(`raw byte file names unavailable: ${left.skipped || right.skipped}`);
    return;
  }
  // Both names decode to the same U+FFFD display string, but not the same bytes.
  assert.equal(left.entries[0].path, right.entries[0].path);
  assert.notEqual(left.digest, right.digest);
  assert.deepEqual(Object.keys(left.entries[0]), ["path", "mode", "size", "sha256"]);
});
