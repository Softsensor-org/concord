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

test("the journal verifies incomplete records before genesis but rejects discontinuities after it", () => {
  const legacy = { id: "legacy", command: "legacy-update" };
  const genesis = { command: "start", prev_event_hash: chain.CHAIN_GENESIS_PREV };
  const linked = { prev_event_hash: chain.hashGovernanceEventRecord(genesis) };
  const events = [legacy, null, genesis, linked, legacy, null];
  const original = structuredClone(events);
  const result = chain.verifyGovernanceChain(events);
  assert.deepEqual(result.accepted, [
    { index: 0, id: legacy.id, command: legacy.command, reason: "pre-chain" },
    { index: 1, id: null, command: null, reason: "pre-chain" },
  ]);
  assert.deepEqual(result.broken, [
    { index: 4, id: legacy.id, command: legacy.command, reason: "missing-prev-hash" },
    { index: 5, id: null, command: null, reason: "missing-prev-hash" },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(events, original);

  const unanchored = { prev_event_hash: "bad-genesis" };
  assert.deepEqual(chain.verifyGovernanceChain([unanchored]).broken, [{
    index: 0, id: null, command: null, reason: "bad-genesis", expected: chain.CHAIN_GENESIS_PREV, actual: "bad-genesis",
  }]);
  assert.deepEqual(chain.verifyGovernanceChain([genesis, unanchored]).broken, [{
    index: 1, id: null, command: null, reason: "prev-hash-mismatch",
    expected: linked.prev_event_hash, actual: "bad-genesis",
  }]);
  const named = { id: "reported-record", command: "land", ...unanchored };
  assert.deepEqual(chain.verifyGovernanceChain([named]).broken, [{
    index: 0, id: named.id, command: named.command, reason: "bad-genesis",
    expected: chain.CHAIN_GENESIS_PREV, actual: "bad-genesis",
  }]);
  assert.deepEqual(chain.verifyGovernanceChain([genesis, named]).broken, [{
    index: 1, id: named.id, command: named.command, reason: "prev-hash-mismatch",
    expected: linked.prev_event_hash, actual: "bad-genesis",
  }]);
});

test("the journal rejects broken migration metadata even when the link matches", () => {
  const migration = { command: chain.CHAIN_MIGRATION_COMMAND, prev_event_hash: chain.CHAIN_GENESIS_PREV };
  const undeclared = chain.verifyGovernanceChain([migration]);
  assert.equal(undeclared.ok, false);
  assert.deepEqual(undeclared.broken, [{
    index: 0, id: null, command: chain.CHAIN_MIGRATION_COMMAND, reason: "migration-missing-sha256-alg",
    expected: chain.HASH_ALG_SHA256, actual: null,
  }]);

  const conflicting = {
    ...migration,
    hash_alg: chain.HASH_ALG_SHA256,
    details: { sha1_chain_head: "recorded-but-not-the-actual-head" },
  };
  const wrongHead = chain.verifyGovernanceChain([conflicting]);
  assert.equal(wrongHead.ok, false);
  assert.deepEqual(wrongHead.broken, [{
    index: 0, id: null, command: chain.CHAIN_MIGRATION_COMMAND, reason: "migration-sha1-head-mismatch",
    expected: chain.CHAIN_GENESIS_PREV, actual: "recorded-but-not-the-actual-head",
  }]);

  const genesis = { id: "first", command: "journal-baseline", prev_event_hash: chain.CHAIN_GENESIS_PREV };
  const oldHead = chain.hashGovernanceEventRecord(genesis);
  const linked = { ...conflicting, id: "migration", prev_event_hash: oldHead };
  assert.deepEqual(chain.verifyGovernanceChain([genesis, linked]).broken, [{
    index: 1, id: linked.id, command: chain.CHAIN_MIGRATION_COMMAND, reason: "migration-sha1-head-mismatch",
    expected: oldHead, actual: conflicting.details.sha1_chain_head,
  }]);
  assert.equal(chain.verifyGovernanceChain([genesis, { ...linked, details: { sha1_chain_head: oldHead } }]).ok, true);
});
