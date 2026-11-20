"use strict";

// COORD-982 (ARCH-AUDIT F-03): the one shared `gh` spawn helper. Callers keep
// their own failure policy; this suite pins the spawn contract they all rely on.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnGh } = require("./gh-spawn.js");

test("COORD-982: spawnGh always spawns the gh binary with the given argv and only the options the caller supplied", () => {
  const seen = [];
  const spawn = (bin, args, opts) => { seen.push({ bin, args, opts }); return { status: 0, stdout: "ok", stderr: "" }; };
  spawnGh(["pr", "list"], { spawn });
  assert.deepEqual(seen[0], { bin: "gh", args: ["pr", "list"], opts: { encoding: "utf8" } });
  spawnGh(["api"], { spawn, cwd: "/repo", env: { PATH: "/bin" }, timeoutMs: 5000 });
  assert.equal(seen[1].opts.cwd, "/repo");
  assert.deepEqual(seen[1].opts.env, { PATH: "/bin" });
  assert.equal(seen[1].opts.timeout, 5000);
  spawnGh(["x"], { spawn, cwd: undefined });
  assert.equal("cwd" in seen[2].opts, false, "an absent cwd is not passed to spawn");
  spawnGh(["y"], { spawn, stdio: "inherit" });
  assert.equal(seen[3].opts.stdio, "inherit");
});

test("COORD-982: spawnGh returns the raw spawn result and never throws on a non-zero status (policy belongs to the caller)", () => {
  const failed = { status: 4, stdout: "", stderr: "not logged in", error: undefined };
  const result = spawnGh(["auth", "status"], { spawn: () => failed });
  assert.equal(result, failed);
});

test("COORD-982: spawnGh uses real child_process spawnSync when no spawn is injected", () => {
  const result = spawnGh(["--version"], { spawn: undefined, env: { ...process.env, PATH: "/nonexistent-coord-982" } });
  assert.ok(result.error, "a missing binary surfaces as result.error rather than a throw");
});
