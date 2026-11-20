"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { MAX_TEXT_INPUT_BYTES, createSafeTextInput } = require("./safe-text-input.js");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-safe-text-input-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("safe text input preserves exact UTF-8 bytes including shell syntax, newlines, and BOM", () => {
  withTempDir((dir) => {
    const source = path.join(dir, "text.md");
    const expected = "\uFEFFline one $(date) `echo x` $HOME 'single' \"double\"\r\nsecond line\n";
    fs.writeFileSync(source, Buffer.from(expected, "utf8"));

    const actual = createSafeTextInput().readUtf8TextFile(source, "--description-file");

    assert.equal(actual, expected);
    assert.deepEqual(Buffer.from(actual, "utf8"), fs.readFileSync(source));
  });
});

test("safe text input refuses empty, whitespace-only, invalid UTF-8, and oversized files", () => {
  withTempDir((dir) => {
    const read = createSafeTextInput().readUtf8TextFile;
    const empty = path.join(dir, "empty");
    const blank = path.join(dir, "blank");
    const invalid = path.join(dir, "invalid");
    const large = path.join(dir, "large");
    fs.writeFileSync(empty, "");
    fs.writeFileSync(blank, " \r\n\t");
    fs.writeFileSync(invalid, Buffer.from([0x66, 0x80, 0x6f]));
    fs.writeFileSync(large, Buffer.alloc(MAX_TEXT_INPUT_BYTES + 1, 0x78));

    assert.throws(() => read(empty), /must not be empty/);
    assert.throws(() => read(blank), /must not be empty/);
    assert.throws(() => read(invalid), /valid UTF-8/);
    assert.throws(() => read(large), /exceeds the .*byte limit/);
  });
});

test("safe text input refuses nonregular paths and returns promptly for a FIFO", () => {
  withTempDir((dir) => {
    const read = createSafeTextInput().readUtf8TextFile;
    const folder = path.join(dir, "folder");
    const fifo = path.join(dir, "pipe");
    fs.mkdirSync(folder);
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(made.status, 0, `mkfifo failed: ${made.stderr}`);

    assert.throws(() => read(folder), /must be a regular file/);
    const started = Date.now();
    assert.throws(() => read(fifo), /must be a regular file/);
    assert.ok(Date.now() - started < 1000, "opening the FIFO must not block");
    assert.equal(fs.lstatSync(fifo).isFIFO(), true, "the FIFO remains unchanged");
  });
});

test("safe text input refuses symlinks rather than following them", () => {
  withTempDir((dir) => {
    const target = path.join(dir, "target");
    const link = path.join(dir, "link");
    fs.writeFileSync(target, "body");
    fs.symlinkSync(target, link);

    assert.throws(() => createSafeTextInput().readUtf8TextFile(link), /could not be opened safely/);
    assert.equal(fs.readFileSync(target, "utf8"), "body");
  });
});

test("safe text input rejects invalid paths and platforms without non-following opens", () => {
  const read = createSafeTextInput().readUtf8TextFile;
  assert.throws(() => read(null), /input file requires a non-empty file path/);
  assert.throws(() => read("  "), /input file requires a non-empty file path/);
  assert.throws(() => read(null, ""), /input file requires a non-empty file path/);

  let opened = false;
  const noNoFollow = createSafeTextInput({
    fs: {
      openSync() { opened = true; },
    },
  }).readUtf8TextFile;
  assert.throws(() => noNoFollow("candidate.txt"), /non-blocking regular-file checks are unavailable/);
  assert.equal(opened, false, "the reader must fail closed before opening without O_NOFOLLOW");
});

test("safe text input preserves metadata/read errors and closes descriptors after failures", () => {
  let metadataClosed = false;
  const metadataFailure = createSafeTextInput({
    fs: {
      constants: fs.constants,
      openSync: () => 41,
      fstatSync() { throw new Error("metadata unavailable"); },
      closeSync(fd) { metadataClosed = fd === 41; throw new Error("close unavailable"); },
    },
  }).readUtf8TextFile;
  assert.throws(() => metadataFailure("candidate.txt"), /could not be inspected: metadata unavailable/);
  assert.equal(metadataClosed, true);

  let readClosed = false;
  const readFailure = createSafeTextInput({
    fs: {
      constants: fs.constants,
      openSync: () => 42,
      fstatSync: () => ({ size: 0, isFile: () => true }),
      readSync() { throw new Error("read interrupted"); },
      closeSync(fd) { readClosed = fd === 42; throw new Error("close unavailable"); },
    },
  }).readUtf8TextFile;
  assert.throws(() => readFailure("candidate.txt"), /could not be read: read interrupted/);
  assert.equal(readClosed, true);
});

test("safe text input enforces its byte bound if a file grows after metadata inspection", () => {
  let totalRead = 0;
  let closed = false;
  const read = createSafeTextInput({
    fs: {
      constants: fs.constants,
      openSync: () => 43,
      fstatSync: () => ({ size: 0, isFile: () => true }),
      readSync(_fd, buffer, offset, length) {
        const count = Math.min(length, MAX_TEXT_INPUT_BYTES + 1 - totalRead);
        buffer.fill(0x78, offset, offset + count);
        totalRead += count;
        return count;
      },
      closeSync(fd) { closed = fd === 43; },
    },
  }).readUtf8TextFile;

  assert.throws(() => read("growing.txt"), /exceeds the .*byte limit/);
  assert.equal(totalRead, MAX_TEXT_INPUT_BYTES + 1);
  assert.equal(closed, true);
});
