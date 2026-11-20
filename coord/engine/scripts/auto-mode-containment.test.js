"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { evaluateGit, evaluateNetwork, evaluatePath, filterEnvironment } = require("./auto-mode-containment.js");

const policy = { worktree: "/repo/.worktrees/T", protected_roots: ["/repo/product"], network_allow: ["registry.npmjs.org"], integration_branches: ["main"] };

test("writes are worktree-only and secret paths are redacted", () => {
  assert.equal(evaluatePath(policy, "/repo/.worktrees/T/src/a.js", "write").decision, "allow");
  assert.match(evaluatePath(policy, "/repo/product/src/a.js", "write").reason, /outside governed worktree/);
  assert.equal(evaluatePath(policy, "/repo/product/src/a.js", "read").reason, "protected product root");
  assert.equal(evaluatePath(policy, "/repo/.env", "read").redacted_target, "[REDACTED_PATH]");
});

test("environment, network, and integration mutations fail closed", () => {
  const filtered = filterEnvironment({ PATH: "/bin", API_TOKEN: "value" }, ["PATH"]);
  assert.deepEqual(filtered.environment, { PATH: "/bin" });
  assert.deepEqual(filtered.removed, ["API_TOKEN"]);
  assert.equal(evaluateNetwork(policy, "https://registry.npmjs.org/pkg").decision, "allow");
  assert.equal(evaluateNetwork(policy, "https://example.com").decision, "deny");
  assert.equal(evaluateGit(policy, { verb: "push", branch: "main" }).decision, "deny");
});

test("symlinked write targets cannot escape the worktree or alias secret files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-containment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, "worktree");
  const outside = path.join(root, "outside");
  fs.mkdirSync(worktree);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(worktree, "escape"));
  fs.writeFileSync(path.join(outside, "id_rsa"), "test-only");
  fs.symlinkSync(path.join(outside, "id_rsa"), path.join(worktree, "alias"));
  const scoped = { worktree };
  assert.equal(evaluatePath(scoped, path.join(worktree, "new", "file.js"), "write").decision, "allow");
  assert.equal(evaluatePath(scoped, path.join(worktree, "escape", "new", "file.js"), "write").decision, "deny");
  assert.equal(evaluatePath(scoped, path.join(worktree, "alias"), "read").reason, "secret path");
  fs.symlinkSync(path.join(root, "missing"), path.join(worktree, "broken"));
  assert.equal(evaluatePath(scoped, path.join(worktree, "broken", "file.js"), "write").decision, "deny");
});

test("a broken worktree alias fails closed before a write can be allowed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-containment-broken-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brokenWorktree = path.join(root, "worktree");
  fs.symlinkSync(path.join(root, "missing"), brokenWorktree);
  const candidate = path.join(root, "candidate.txt");
  fs.writeFileSync(candidate, "unchanged\n");
  const result = evaluatePath({ worktree: brokenWorktree }, candidate, "write");
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "write outside governed worktree");
  assert.equal(fs.readFileSync(candidate, "utf8"), "unchanged\n");
});

test("unreadable path metadata and literal secret patterns fail closed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-containment-unreadable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate.txt");
  fs.writeFileSync(candidate, "unchanged\n");
  const originalLstat = fs.lstatSync;
  fs.lstatSync = (target, ...args) => {
    if (target === candidate) throw Object.assign(new Error("unreadable metadata"), { code: "EACCES" });
    return originalLstat(target, ...args);
  };
  try {
    assert.equal(evaluatePath({ worktree: root }, candidate, "write").reason, "path cannot be resolved");
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(evaluatePath({ worktree: root, secret_paths: ["candidate.txt"] }, candidate, "read").reason, "secret path");
  assert.equal(fs.readFileSync(candidate, "utf8"), "unchanged\n");
});

test("filesystem-root exhaustion while resolving a path fails closed", () => {
  const root = path.parse(path.resolve("/unreachable")).root;
  const originalLstat = fs.lstatSync;
  fs.lstatSync = (target, ...args) => {
    if (path.resolve(String(target)) === root) throw Object.assign(new Error("injected missing filesystem root"), { code: "ENOENT" });
    return originalLstat(target, ...args);
  };
  try {
    const result = evaluatePath({ worktree: "/missing/worktree" }, "/missing/worktree/file.js", "write");
    assert.deepEqual(result, { decision: "deny", reason: "path cannot be resolved" });
  } finally {
    fs.lstatSync = originalLstat;
  }
});

test("environment only retains explicitly approved keys", () => {
  const filtered = filterEnvironment({ PATH: "/bin", AWS_ACCESS_KEY_ID: "x", DATABASE_URL: "x", GH_PAT: "x", KUBECONFIG: "x", SSH_AUTH_SOCK: "x" }, ["PATH"]);
  assert.deepEqual(filtered.environment, { PATH: "/bin" });
  assert.deepEqual(filtered.removed, ["AWS_ACCESS_KEY_ID", "DATABASE_URL", "GH_PAT", "KUBECONFIG", "SSH_AUTH_SOCK"]);
  assert.deepEqual(filterEnvironment({ PATH: "/bin" }).environment, {});
});

test("network allowance requires HTTPS on port 443 without URL credentials", () => {
  for (const target of ["http://registry.npmjs.org/pkg", "https://registry.npmjs.org:8443/pkg", "https://user:pass@registry.npmjs.org/pkg", "https://example.com/pkg"]) {
    assert.equal(evaluateNetwork(policy, target).decision, "deny", target);
  }
  assert.equal(evaluateNetwork(policy, "https://registry.npmjs.org:443/pkg").decision, "allow");
  assert.equal(evaluateNetwork({}, "https://registry.npmjs.org/pkg").decision, "deny");
});

test("Git integration refs and unknown HEAD are protected", () => {
  for (const branch of ["main", "origin/main", "refs/heads/main", "refs/remotes/origin/main", "HEAD", "HEAD~1", ""]) {
    assert.equal(evaluateGit(policy, { verb: "push", branch }).decision, "deny", branch);
  }
  assert.equal(evaluateGit(policy, { verb: "push", branch: "topic/fix" }).decision, "allow");
});

test("common private key and tool configuration paths are secret", () => {
  for (const name of ["id_rsa", "client.pem", "server.key", ".npmrc", ".kube/config", ".docker/config.json"]) {
    assert.equal(evaluatePath(policy, `/repo/.worktrees/T/${name}`, "read").reason, "secret path", name);
  }
});
