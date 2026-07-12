"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateGit, evaluateNetwork, evaluatePath, filterEnvironment } = require("./auto-mode-containment.js");

const policy = { worktree: "/repo/.worktrees/T", protected_roots: ["/repo/product"], network_allow: ["registry.npmjs.org"], integration_branches: ["main"] };

test("writes are worktree-only and secret paths are redacted", () => {
  assert.equal(evaluatePath(policy, "/repo/.worktrees/T/src/a.js", "write").decision, "allow");
  assert.match(evaluatePath(policy, "/repo/product/src/a.js", "write").reason, /outside governed worktree/);
  assert.equal(evaluatePath(policy, "/repo/.env", "read").redacted_target, "[REDACTED_PATH]");
});

test("environment, network, and integration mutations fail closed", () => {
  const filtered = filterEnvironment({ PATH: "/bin", API_TOKEN: "value" });
  assert.deepEqual(filtered.environment, { PATH: "/bin" });
  assert.deepEqual(filtered.removed, ["API_TOKEN"]);
  assert.equal(evaluateNetwork(policy, "https://registry.npmjs.org/pkg").decision, "allow");
  assert.equal(evaluateNetwork(policy, "https://example.com").decision, "deny");
  assert.equal(evaluateGit(policy, { verb: "push", branch: "main" }).decision, "deny");
});
