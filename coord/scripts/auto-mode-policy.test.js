"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPolicy, policyDigest, validateAction, validatePolicy, SCHEMA_VERSION } = require("./auto-mode-policy.js");

const input = { ticket: "COORD-496", session: "s-1", worktree: "/tmp/wt", capabilities: { commands: ["node --test"], network: "deny", secrets: "deny" } };

test("buildPolicy emits a stable versioned digest", () => {
  const policy = buildPolicy(input);
  assert.equal(policy.schema, SCHEMA_VERSION);
  assert.equal(policy.digest, policyDigest({ schema: SCHEMA_VERSION, ...input }));
  assert.equal(policy.digest, buildPolicy({ ...input, capabilities: { secrets: "deny", network: "deny", commands: ["node --test"] } }).digest);
});

test("policy and action validators fail closed", () => {
  assert.equal(validatePolicy({}).ok, false);
  assert.equal(validateAction({ schema: SCHEMA_VERSION, id: "a", ticket: "T", session: "s", kind: "write", decision: "deny", sequence: 1 }).ok, false);
  assert.equal(validateAction({ schema: SCHEMA_VERSION, id: "a", ticket: "T", session: "s", kind: "write", decision: "deny", reason: "outside worktree", sequence: 1 }).ok, true);
});
