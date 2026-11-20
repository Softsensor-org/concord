"use strict";

// COORD-143: tests for the Phase-3 VECTOR-SIMILARITY layer (memory-vector.js).
//
// Cover: the local hashed embedder is deterministic, normalized, and
// dependency-free; cosine behaves; the pluggable provider interface works; and
// the path is OFF (returns null) when no provider is present (graceful skip).

const test = require("node:test");
const assert = require("node:assert/strict");

const vec = require("./memory-vector.js");

test("local embedder produces a fixed-dimension, deterministic, L2-normalized vector", () => {
  const e = vec.localEmbedder();
  const a = e.embed("repair the broken hash chain");
  const b = e.embed("repair the broken hash chain");
  assert.equal(a.length, vec.DEFAULT_DIM);
  assert.deepEqual(a, b, "same text must embed identically");
  // L2 norm ~ 1.
  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9 || norm === 0);
});

test("cosine: identical vectors ~1, related text > unrelated text", () => {
  const e = vec.localEmbedder();
  const q = e.embed("conformance attestation ed25519 signing");
  assert.ok(Math.abs(vec.cosine(q, q) - 1) < 1e-9);
  const related = e.embed("the attestation signs with an ed25519 key");
  const unrelated = e.embed("frontend button color tokens and spacing");
  assert.ok(
    vec.cosine(q, related) > vec.cosine(q, unrelated),
    "related text must be more similar than unrelated"
  );
});

test("cosine is 0 for degenerate / mismatched inputs", () => {
  assert.equal(vec.cosine([], []), 0);
  assert.equal(vec.cosine([1, 2], [1, 2, 3]), 0);
  assert.equal(vec.cosine([0, 0], [0, 0]), 0);
});

test("embedWith works with a usable provider and is OFF (null) without one", () => {
  const e = vec.localEmbedder();
  const texts = ["alpha", "beta"];
  const out = vec.embedWith(e, texts);
  assert.ok(Array.isArray(out) && out.length === 2);
  // No provider => vector path OFF (graceful skip).
  assert.equal(vec.embedWith(null, texts), null);
  assert.equal(vec.embedWith({}, texts), null, "an object without embed() is not a provider");
  assert.equal(vec.embedWith({ embed: 42 }, texts), null);
});

test("isProvider validates the pluggable interface", () => {
  assert.equal(vec.isProvider(vec.localEmbedder()), true);
  assert.equal(vec.isProvider({ embed: () => [1, 2, 3] }), true);
  assert.equal(vec.isProvider(null), false);
  assert.equal(vec.isProvider({}), false);
});

test("a custom (fake) provider can be plugged in without any dependency", () => {
  // Stand-in for an adopter-supplied embedding service: a trivial deterministic
  // provider. Proves the interface is honored without bundling a model.
  const fakeProvider = {
    name: "fake",
    embed: (text) => [String(text).length, (text.match(/a/g) || []).length],
  };
  const out = vec.embedWith(fakeProvider, ["aaa", "bb"]);
  assert.deepEqual(out, [[3, 3], [2, 0]]);
});

test("rankByVector ranks the most-similar doc first, deterministic tie-break", () => {
  const e = vec.localEmbedder();
  const docs = [
    e.embed("frontend spacing tokens"),
    e.embed("hash chain repair and prev_event_hash relinking"),
    e.embed("nothing related at all xyzzy"),
  ];
  const q = e.embed("how was the hash chain repaired");
  const ranked = vec.rankByVector(q, docs);
  assert.equal(ranked[0].index, 1, "the hash-chain doc must rank first");
  // Stable shape.
  for (const r of ranked) {
    assert.equal(typeof r.index, "number");
    assert.equal(typeof r.score, "number");
  }
});
