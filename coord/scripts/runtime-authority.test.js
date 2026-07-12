"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertAutoModeAllowed, createEnvelope, deriveSubagentEnvelope, evaluateToolCall, finishSubagent, probeRuntimeCoverage, registerSubagent, supervisionReport } = require("./runtime-authority.js");

const parent = createEnvelope({ ticket: "T-1", session: "parent", provider: "claude", worktree: "/repo/wt", write_roots: ["/repo/wt"], commands: ["test"], network: [], secrets: [], coverage: "partial" });

test("destructive commands and outside-worktree writes are denied", () => {
  assert.equal(evaluateToolCall(parent, { tool: "Bash", input: { command: "rm -rf $HOME" } }).decision, "deny");
  assert.equal(evaluateToolCall(parent, { tool: "Bash", input: { command: "bash -lc 'git reset --hard HEAD'" } }).decision, "deny");
  assert.equal(evaluateToolCall(parent, { tool: "Write", input: { file_path: "/repo/wt/src/a.js" } }).decision, "allow");
  assert.equal(evaluateToolCall(parent, { tool: "Write", input: { file_path: "/outside/important.txt" } }).decision, "deny");
  assert.equal(evaluateToolCall(parent, { tool: "apply_patch", input: { patch: "*** Delete File: x" } }).decision, "deny");
});

test("subagents can only inherit narrower-or-equal authority", () => {
  const child = deriveSubagentEnvelope(parent, { session: "child", write_roots: ["/repo/wt/src"], commands: ["test"] });
  assert.equal(child.parent_session, "parent");
  assert.throws(() => deriveSubagentEnvelope(parent, { session: "bad", write_roots: ["/repo"] }), /authority expansion/);
  assert.throws(() => deriveSubagentEnvelope(parent, { session: "bad", commands: ["deploy"] }), /authority expansion/);
});

test("closeout supervision fails for active or unexplained subagents", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "concord-supervision-"));
  const file = path.join(dir, "state.json");
  const child = deriveSubagentEnvelope(parent, { session: "child", commands: [] });
  registerSubagent(file, parent, child);
  assert.deepEqual(supervisionReport(file, "T-1").active, ["child"]);
  finishSubagent(file, "child", { explained: true, action_digest: "sha256:abc" });
  assert.equal(supervisionReport(file, "T-1").ok, true);
});

test("provider coverage prevents unsupported high-risk auto mode", () => {
  const claude = probeRuntimeCoverage({ provider: "claude", preToolHook: true, subagentHooks: true, sandboxMode: "workspace-write" });
  assert.equal(claude.coverage, "complete");
  assert.equal(assertAutoModeAllowed(claude, "high"), true);
  const codex = probeRuntimeCoverage({ provider: "codex", sandboxMode: "workspace-write" });
  assert.equal(codex.coverage, "partial");
  assert.throws(() => assertAutoModeAllowed(codex, "high"), /requires complete/);
  assert.throws(() => assertAutoModeAllowed(probeRuntimeCoverage({ provider: "codex", sandboxMode: "danger-full-access" })), /unmanaged/);
});
