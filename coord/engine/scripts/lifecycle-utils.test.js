"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert");
const {
  slugify,
  integerOrDefault,
  inferNextRound,
  currentReviewRound,
  todayIso,
  escapeTable,
  escapeRegex,
  shellEscape,
  stableStringify,
  sha1,
  sha256Hex,
  sha256Text,
  sha256Prefixed,
  readJson,
  readJsonStrict,
  mapBoardTableRows,
  readJsonIfExists,
  isPlainObject,
  normalizePath,
  toPosix,
} = require("./lifecycle-utils.js");

test("slugify lowercases, collapses non-alphanumerics, and trims dashes", () => {
  assert.equal(slugify("Add Auth Seams!"), "add-auth-seams");
  assert.equal(slugify("  --Hello, World--  "), "hello-world");
});

test("slugify falls back to 'work' for empty/blank input", () => {
  assert.equal(slugify(""), "work");
  assert.equal(slugify(null), "work");
  assert.equal(slugify("***"), "work");
});

test("integerOrDefault parses integers and returns fallback otherwise", () => {
  assert.equal(integerOrDefault("42", 5), 42);
  assert.equal(integerOrDefault(7, 5), 7);
  assert.equal(integerOrDefault(undefined, 5), 5);
  assert.equal(integerOrDefault(null, 5), 5);
  assert.equal(integerOrDefault("not-a-number", 5), 5);
});

test("inferNextRound returns 1 for no findings and max+1 otherwise", () => {
  assert.equal(inferNextRound([]), 1);
  assert.equal(inferNextRound(null), 1);
  assert.equal(inferNextRound([{ round: 1 }, { round: 3 }, { round: 2 }]), 4);
  assert.equal(inferNextRound([{}, {}]), 2);
});

// COORD-649: `currentReviewRound` answers "what round is the ticket IN", which
// is NOT `inferNextRound` ("what round does return-doing advance INTO"). Using
// the latter for add-finding auto-incremented findings from one review to
// rounds 1..N and manufactured a required plan round no writer could produce.
test("currentReviewRound reads the plan record, and never advances past it", () => {
  // Plan record is authoritative when it carries a usable round.
  assert.equal(currentReviewRound({ review_round: 2 }, [{ round: 1 }]), 2);
  // ...including over findings misclassified ABOVE it (the wedge shape).
  assert.equal(currentReviewRound({ review_round: 1 }, [{ round: 1 }, { round: 2 }, { round: 3 }]), 1);
  // No plan record: fall back to the round the findings evidence, NOT max+1.
  assert.equal(currentReviewRound(null, [{ round: 1 }, { round: 1 }]), 1);
  assert.equal(currentReviewRound(null, [{ round: 2 }]), 2);
  // Nothing recorded at all: a ticket is in round 1.
  assert.equal(currentReviewRound(null, []), 1);
  assert.equal(currentReviewRound(undefined, undefined), 1);
  // Unusable values degrade to 1 rather than to NaN or to a fabricated round.
  assert.equal(currentReviewRound({ review_round: 0 }, []), 1);
  assert.equal(currentReviewRound({ review_round: "two" }, [{ round: 1 }]), 1);
  assert.equal(currentReviewRound({}, [{}, {}]), 1);
});

test("todayIso returns a YYYY-MM-DD date string", () => {
  assert.match(todayIso(), /^\d{4}-\d{2}-\d{2}$/);
});

test("escapeTable escapes pipes and flattens newlines for markdown tables", () => {
  assert.equal(escapeTable("a | b"), "a \\| b");
  assert.equal(escapeTable("line1\nline2"), "line1 line2");
});

test("escapeRegex escapes regex metacharacters", () => {
  assert.equal(escapeRegex("a.b*c"), "a\\.b\\*c");
  const pattern = new RegExp(`^${escapeRegex("F/.worktrees/")}`);
  assert.ok(pattern.test("F/.worktrees/owner/FE-1/"));
  assert.ok(!pattern.test("FXworktrees/"));
});

test("shellEscape single-quotes values and neutralizes embedded quotes", () => {
  assert.equal(shellEscape("plain"), "'plain'");
  assert.equal(shellEscape("it's"), "'it'\\''s'");
});

// COORD-980 (F-01): stableStringify feeds digests. These outputs were captured from the
// pre-hoist copy (closeout-summary.js on origin/dev); the shared copy must reproduce them byte for byte.
test("stableStringify output is byte-identical to the pre-hoist copy on fixture inputs", () => {
  const cases = [
    [{ b: 1, a: [2, { d: undefined, c: null }] }, '{"a":[2,{"c":null,"d":null}],"b":1}'],
    [undefined, "null"],
    [null, "null"],
    ['é\n"q"', '"é\\n\\"q\\""'],
    [NaN, "null"],
    [Infinity, "null"],
    [[undefined, () => 1], "[null,]"],
    [{ z: { y: { x: [1, "two", false] } }, a: "ß" }, '{"a":"ß","z":{"y":{"x":[1,"two",false]}}}'],
    [{ 'k"ey': 1, ünï: 2 }, '{"k\\"ey":1,"ünï":2}'],
    [new Date(0), "{}"],
    [0, "0"],
    [-0, "0"],
    [1e21, "1e+21"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(stableStringify(input), expected);
  }
});

test("sha1 and sha256Hex are lowercase hex digests of their input", () => {
  assert.equal(sha1("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("readJson returns parsed JSON, or the fallback (default null) when missing or malformed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-utils-readjson-"));
  try {
    const good = path.join(dir, "good.json");
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(good, '{"a":1}');
    fs.writeFileSync(bad, "{not json");
    assert.deepEqual(readJson(good), { a: 1 });
    assert.equal(readJson(bad), null);
    assert.equal(readJson(path.join(dir, "missing.json")), null);
    assert.deepEqual(readJson(path.join(dir, "missing.json"), {}), {});
    assert.equal(readJson(bad, "fallback"), "fallback");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonIfExists returns the fallback for a missing or empty path and parsed JSON otherwise", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-utils-readjsonifexists-"));
  try {
    const file = path.join(dir, "x.json");
    fs.writeFileSync(file, "[1,2]");
    assert.deepEqual(readJsonIfExists(file, {}), [1, 2]);
    assert.deepEqual(readJsonIfExists(path.join(dir, "missing.json"), { fallback: true }), { fallback: true });
    assert.equal(readJsonIfExists("", "none"), "none");
    assert.equal(readJsonIfExists(undefined, "none"), "none");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isPlainObject is true only for non-array objects", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(undefined), false);
  assert.equal(isPlainObject("x"), false);
  assert.equal(isPlainObject(0), false);
});

test("normalizePath trims, converts backslashes, and strips a leading ./", () => {
  assert.equal(normalizePath(".\\a\\b"), "a/b");
  assert.equal(normalizePath("./x/y"), "x/y");
  assert.equal(normalizePath("  p  "), "p");
  assert.equal(normalizePath(null), "");
});

test("toPosix converts platform separators to forward slashes", () => {
  assert.equal(toPosix(["a", "b", "c"].join(path.sep)), "a/b/c");
  assert.equal(toPosix("already/posix"), "already/posix");
});

// COORD-999 (batch 2 of COORD-980 F-01): characterization for the helpers hoisted from the
// per-module copies. Each expected value is the body the removed copy computed.
test("sha256Text hashes String(value) as UTF-8 and returns lowercase hex", () => {
  const crypto = require("node:crypto");
  const hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
  assert.equal(sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Text(42), hex("42"));
  assert.equal(sha256Text("caf\u00e9"), hex("caf\u00e9"));
});

test("sha256Prefixed hashes the UTF-8 text and prefixes the digest with sha256:", () => {
  assert.equal(sha256Prefixed("abc"), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Prefixed(""), "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("readJsonStrict parses valid JSON and throws on a missing or malformed file (no fallback)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-utils-readjsonstrict-"));
  try {
    const good = path.join(dir, "good.json");
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(good, '{"a":[1,2]}');
    fs.writeFileSync(bad, "{not json");
    assert.deepEqual(readJsonStrict(good), { a: [1, 2] });
    assert.throws(() => readJsonStrict(bad), SyntaxError);
    assert.throws(() => readJsonStrict(path.join(dir, "missing.json")), { code: "ENOENT" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readJson with one argument returns null for a directory or a missing file, as the removed one-argument copies did", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-utils-readjson-arity-"));
  try {
    assert.equal(readJson(dir), null);
    assert.equal(readJson(path.join(dir, "missing.json")), null);
    const boardPath = path.join(dir, "board.json");
    fs.writeFileSync(boardPath, JSON.stringify({ sections: null }));
    assert.deepEqual(mapBoardTableRows(boardPath, () => assert.fail("non-table board has no rows")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
