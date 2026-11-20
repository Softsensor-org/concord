"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPolicy, policyDigest, validateAction, validateEvent, validatePolicy, SCHEMA_VERSION, EVENT_SCHEMA_VERSION, POLICY_SCHEMA_VERSION } = require("./auto-mode-policy.js");

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

function bounded() {
  return {
    schema: POLICY_SCHEMA_VERSION, ticket: "COORD-489", session: "s-1", owner: "codex",
    provider: "codex", adapter_version: "1", worktree: "/repo/.worktrees/T", base_sha: "abc",
    read_roots: ["/repo"], write_roots: ["/repo/.worktrees/T"], denied_paths: [".env", ".ssh"],
    command_classes: ["local-test", "local-build"], child_process_egress: "deny",
    provider_control_plane: { channel: "local-adapter", network: "deny" },
    secret_reference_policy: { mode: "deny", references: "none" },
    git_remote_actions: { commit: "ticket-branch", push: "deny", merge: "deny" },
    approval_boundaries: { expansion: "explicit-ticket-decision" }, limits: { minutes: 60, cost: 0 },
    evidence_coverage: "complete", label: "managed-auto"
  };
}

test("complete bounded policy validates and rejects unsafe scope", () => {
  assert.equal(validatePolicy(bounded()).ok, true);
  assert.match(validatePolicy({ ...bounded(), write_roots: ["/repo/other"] }).errors.join(" "), /write_roots/);
  assert.match(validatePolicy({ ...bounded(), child_process_egress: "allow" }).errors.join(" "), /child_process_egress/);
  assert.match(validatePolicy({ ...bounded(), api_token: "raw" }).errors.join(" "), /raw secret/);
  assert.match(validatePolicy({ ...bounded(), evidence_coverage: "unmanaged" }).errors.join(" "), /managed-auto/);
});

test("events are normalized, relative, and redacted", () => {
  const event = { schema: EVENT_SCHEMA_VERSION, id: "e1", ticket: "COORD-489", session: "s-1", policy_digest: "d", class: "shell", status: "completed", resource: "coord/scripts/test.js", redacted_summary: "node test" };
  assert.equal(validateEvent(event).ok, true);
  assert.match(validateEvent({ ...event, resource: "/etc/passwd" }).errors.join(" "), /relative/);
  assert.match(validateEvent({ ...event, secret: "value" }).errors.join(" "), /raw secret/);
});
