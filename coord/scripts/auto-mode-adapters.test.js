"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPolicy, SCHEMA_VERSION } = require("./auto-mode-policy.js");
const { enforceAction, probeProvider } = require("./auto-mode-adapters.js");

test("capability probes distinguish complete, partial, and unmanaged", () => {
  const exists = (value) => value.endsWith("settings.json") || value.endsWith("config.toml");
  assert.equal(probeProvider("codex", "/repo", { exists }).coverage, "complete");
  assert.equal(probeProvider("claude", "/repo", { exists }).coverage, "partial");
  assert.equal(probeProvider("unknown", "/repo", { exists }).coverage, "unmanaged");
});

test("adapter denies actions it cannot prove or whose policy changed", () => {
  const policy = buildPolicy({ ticket: "T", session: "S", worktree: "/repo", capabilities: {} });
  const probe = probeProvider("claude", "/repo", { exists: () => true });
  const action = { schema: SCHEMA_VERSION, id: "a1", ticket: "T", session: "S", kind: "network", decision: "allow", sequence: 1, policy_digest: policy.digest };
  assert.equal(enforceAction(policy, action, probe).decision, "deny");
  assert.match(enforceAction(policy, { ...action, kind: "command", policy_digest: "stale" }, probe).reason, /digest mismatch/);
});
