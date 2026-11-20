"use strict";

// COORD-987 (F-11): one read-only NDJSON reader for journal consumers. It skips
// only blank lines. A malformed line (including a torn trailing line) is returned
// flagged with `error`, never dropped, so each caller must choose its policy.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readNdjsonRecords } = require("./ndjson-records.js");

function withFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-987-ndjson-"));
  try {
    const file = path.join(dir, "journal.ndjson");
    if (content !== null) fs.writeFileSync(file, content, "utf8");
    return fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("COORD-987: valid lines return line, record and physical index", () => {
  withFile('{"ticket":"COORD-1"}\n{"ticket":"COORD-2"}\n', (file) => {
    const entries = readNdjsonRecords(file);
    assert.deepEqual(entries.map((e) => e.record), [{ ticket: "COORD-1" }, { ticket: "COORD-2" }]);
    assert.deepEqual(entries.map((e) => e.index), [0, 1]);
    assert.deepEqual(entries.map((e) => e.line), ['{"ticket":"COORD-1"}', '{"ticket":"COORD-2"}']);
    assert.ok(entries.every((e) => e.error === null));
  });
});

test("COORD-987: blank lines are skipped but still advance the physical index", () => {
  withFile('\n{"a":1}\n\n   \n{"a":2}\r\n', (file) => {
    const entries = readNdjsonRecords(file);
    assert.deepEqual(entries.map((e) => e.index), [1, 4]);
    assert.deepEqual(entries.map((e) => e.record), [{ a: 1 }, { a: 2 }]);
    assert.equal(entries[1].line, '{"a":2}');
  });
});

test("COORD-987: a torn trailing line is returned flagged, not silently dropped", () => {
  withFile('{"a":1}\n{"ticket":"COORD-3","comm', (file) => {
    const entries = readNdjsonRecords(file);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].error, null);
    assert.equal(entries[1].index, 1);
    assert.equal(entries[1].record, undefined);
    assert.ok(entries[1].error instanceof SyntaxError);
  });
});

test("COORD-987: a malformed middle line is returned flagged and later lines keep their index", () => {
  withFile('{"a":1}\nnot-json\n{"a":3}\n', (file) => {
    const entries = readNdjsonRecords(file);
    assert.deepEqual(entries.map((e) => e.index), [0, 1, 2]);
    assert.equal(entries[1].error instanceof SyntaxError, true);
    assert.deepEqual(entries[2].record, { a: 3 });
  });
});

test("COORD-987: a strict consumer that refuses any flagged line fails on a torn line", () => {
  withFile('{"a":1}\n{"torn', (file) => {
    const strict = () => {
      for (const entry of readNdjsonRecords(file)) {
        if (entry.error) throw new Error(`invalid journal line ${entry.index + 1}`);
      }
    };
    assert.throws(strict, /invalid journal line 2/);
  });
});

test("COORD-987: empty and missing files read as no entries", () => {
  withFile("", (file) => assert.deepEqual(readNdjsonRecords(file), []));
  withFile(null, (file) => assert.deepEqual(readNdjsonRecords(file), []));
});

test("COORD-987: read failures other than a missing file propagate", () => {
  withFile(null, (file, dir) => {
    fs.mkdirSync(file);
    assert.throws(() => readNdjsonRecords(file), /EISDIR|illegal operation/);
    assert.ok(dir);
  });
});
