"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPrefixUseReporter } = require("./dispatch-prefix-observation.js");

function fixture(t, identity) {
  const mutations = [];
  const output = [];
  t.mock.method(console, "log", (value) => output.push(JSON.parse(value)));
  const report = createPrefixUseReporter({
    fail: (message) => { throw new Error(message); },
    ensureCurrentAgentIdentity: identity,
    withGovernanceMutation: (metadata, callback) => {
      const result = callback();
      mutations.push(metadata);
      return result;
    },
    readBoard: () => ({ ticket: "C-001" }),
    getTicketRef: (board, ticket) => board.ticket === ticket,
  });
  return { report, mutations, output };
}

test("prefix reports validate ticket and both hashes before attempting a mutation", (t) => {
  const f = fixture(t, () => { throw new Error("identity must not be consulted"); });
  assert.throws(() => f.report(), /requires <ticket-id>/);
  assert.throws(() => f.report("C-001"), /expected-prefix-hash/);
  assert.throws(() => f.report("C-001", { expectedPrefixHash: "a".repeat(64) }), /used-prefix-hash/);
  assert.throws(() => f.report("C-001", { expectedPrefixHash: "g".repeat(64) }), /expected-prefix-hash/);
  assert.throws(() => f.report("C-001", { expectedPrefixHash: "a".repeat(64), usedPrefixHash: "x" }), /used-prefix-hash/);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.output.length, 0);
});

test("matching reports normalize hashes and retain the real reporting identity", (t) => {
  const identity = { agent: { handle: "agent1" } };
  const f = fixture(t, (options) => {
    assert.deepEqual(options, { allowAutoClaim: false, touchSession: false });
    return identity;
  });
  const result = f.report("C-001", {
    expectedPrefixHash: ` ${"A".repeat(64)} `,
    usedPrefixHash: "a".repeat(64),
  });
  assert.equal(result.status, "match");
  assert.equal(result.observation_only, true);
  assert.equal(result.reported_by, "agent1");
  assert.equal(result.expected_prefix_hash, "a".repeat(64));
  assert.deepEqual(f.output, [result]);
  assert.equal(f.mutations[0].identity, identity);
  assert.equal(f.mutations[0].forceLog, true);
  assert.equal(f.mutations[0].details.event_type, "dispatch.prefix_used");
});

test("mismatches remain observations when identity is unavailable or incomplete", (t) => {
  let identity = () => { throw new Error("no bound identity"); };
  const f = fixture(t, () => identity());
  const options = { expectedPrefixHash: "a".repeat(64), usedPrefixHash: "b".repeat(64) };
  for (const next of [identity, () => ({}), () => ({ agent: {} })]) {
    identity = next;
    const result = f.report("C-001", options);
    assert.equal(result.status, "mismatch");
    assert.equal(result.reported_by, null);
    assert.equal(result.observation_only, true);
  }
  assert.equal(f.mutations[0].identity, null);
  assert.throws(() => f.report("UNKNOWN", options), /Unknown ticket/);
  assert.equal(f.mutations.length, 3);
  assert.equal(f.output.length, 3);
});
