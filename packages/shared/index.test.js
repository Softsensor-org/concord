"use strict";

// @coord/shared tests (COORD-136). Proves the convergence-target package is
// well-formed: it loads, re-exports its utilities, and each utility behaves.
// Zero runtime deps; pure functions only.

const test = require("node:test");
const assert = require("node:assert");

const shared = require("./index.js");

test("package loads and re-exports its public surface", () => {
  for (const name of ["formatBytes", "truncate", "pluralize", "ok", "err", "attempt", "mapResult"]) {
    assert.equal(typeof shared[name], "function", `expected ${name} to be exported as a function`);
  }
});

test("package.json is zero-dependency (convergence target stays dep-free)", () => {
  const pkg = require("./package.json");
  assert.equal(pkg.name, "@coord/shared");
  assert.deepEqual(pkg.dependencies, {}, "the shared package must carry zero runtime dependencies");
});

test("formatBytes renders human-readable sizes", () => {
  assert.equal(shared.formatBytes(0), "0 B");
  assert.equal(shared.formatBytes(512), "512 B");
  assert.equal(shared.formatBytes(1536), "1.5 KB");
  assert.equal(shared.formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(shared.formatBytes(-5), "0 B");
  assert.equal(shared.formatBytes("nope"), "0 B");
});

test("truncate respects the max-length budget including the ellipsis", () => {
  assert.equal(shared.truncate("hello", 10), "hello");
  assert.equal(shared.truncate("hello world", 8), "hello w…");
  assert.equal(shared.truncate("hello world", 8).length, 8);
  assert.equal(shared.truncate("abc", 0), "abc");
});

test("pluralize is count-aware with an optional explicit plural", () => {
  assert.equal(shared.pluralize(1, "ticket"), "1 ticket");
  assert.equal(shared.pluralize(3, "ticket"), "3 tickets");
  assert.equal(shared.pluralize(2, "match", "matches"), "2 matches");
});

test("result helpers construct and map tagged results", () => {
  assert.deepEqual(shared.ok(42), { ok: true, value: 42 });
  assert.deepEqual(shared.err(new Error("boom")), { ok: false, error: "boom" });
  assert.deepEqual(shared.err("plain"), { ok: false, error: "plain" });

  const good = shared.attempt(() => 7);
  assert.deepEqual(good, { ok: true, value: 7 });
  const bad = shared.attempt(() => { throw new Error("nope"); });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "nope");

  assert.deepEqual(shared.mapResult(shared.ok(2), (v) => v * 5), { ok: true, value: 10 });
  // Failures pass through map untouched.
  const failure = shared.err("x");
  assert.equal(shared.mapResult(failure, (v) => v * 5), failure);
});
