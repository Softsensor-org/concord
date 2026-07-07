"use strict";

// COORD-435: direct coverage for journal-chain.js — the tamper-evidence hashing
// primitives + chain verifier. Previously exercised only indirectly via journal.js.

const test = require("node:test");
const assert = require("node:assert");
const chain = require("./journal-chain.js");

test("COORD-435: sha256/sha1 are deterministic hex digests of the expected length", () => {
  assert.equal(chain.sha256("abc"), chain.sha256("abc"));
  assert.match(chain.sha256("abc"), /^[0-9a-f]{64}$/);
  assert.match(chain.sha1("abc"), /^[0-9a-f]{40}$/);
  assert.notEqual(chain.sha256("abc"), chain.sha256("abd"));
});

test("COORD-435: hashWithAlg dispatches on the algorithm", () => {
  assert.equal(chain.hashWithAlg("x", chain.HASH_ALG_SHA256), chain.sha256("x"));
  assert.equal(chain.hashWithAlg("x", chain.HASH_ALG_SHA1), chain.sha1("x"));
  // Unknown/absent alg falls back to sha1 (the legacy default).
  assert.equal(chain.hashWithAlg("x", "unknown"), chain.sha1("x"));
});

test("COORD-435: eventHashAlg defaults to sha1 and honors an explicit record alg", () => {
  assert.equal(chain.eventHashAlg(null), chain.HASH_ALG_SHA1);
  assert.equal(chain.eventHashAlg({}), chain.HASH_ALG_SHA1);
  assert.equal(chain.eventHashAlg({ hash_alg: chain.HASH_ALG_SHA256 }), chain.HASH_ALG_SHA256);
});

test("COORD-435: chain constants are stable", () => {
  assert.equal(chain.CHAIN_GENESIS_PREV, "genesis");
  assert.equal(chain.HASH_ALG_SHA256, "sha256");
  assert.equal(chain.HASH_ALG_SHA1, "sha1");
});

test("COORD-435: verifyGovernanceChain reports no broken links for an empty chain", () => {
  const result = chain.verifyGovernanceChain([]);
  assert.ok(Array.isArray(result.broken));
  assert.equal(result.broken.length, 0);
});
