"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  slugify,
  integerOrDefault,
  inferNextRound,
  todayIso,
  escapeTable,
  escapeRegex,
  shellEscape,
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
