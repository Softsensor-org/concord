"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

// COORD-486: module-owned tests for the ONE bounded process-group runner the
// policy adapters share. Every collaborator is injected; the last test drives
// the real default spawn/kill against a hung child so the production default is
// proven, not just the injected seam.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { runBoundedProcessGroup } = require("./bounded-process-runner.js");

function fakeChild({ withPipes = true } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  if (withPipes) {
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
  }
  return child;
}

test("COORD-486: spawns the argv as its own process group and resolves the captured output on close", async () => {
  const child = fakeChild();
  const calls = [];
  const pending = runBoundedProcessGroup(
    { bin: "/x/tool", args: ["--json", "."], cwd: "/x", timeoutMs: 5000, defaultTimeoutMs: 1 },
    { spawn: (bin, args, options) => { calls.push({ bin, args, options }); return child; } },
  );
  child.stdout.emit("data", "out-1 ");
  child.stdout.emit("data", "out-2");
  child.stderr.emit("data", "warn");
  child.emit("close", 3);
  assert.deepEqual(await pending, { status: 3, timedOut: false, bound: 5000, stdout: "out-1 out-2", stderr: "warn" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "/x/tool");
  assert.deepEqual(calls[0].args, ["--json", "."]);
  assert.equal(calls[0].options.cwd, "/x");
  assert.equal(calls[0].options.detached, true, "own process group so a negative-pid kill reaches the tree");
  assert.equal(calls[0].options.env, process.env);
});

test("COORD-486: a hung tool is SIGKILLed by NEGATIVE pid at the bound and resolves timedOut", async () => {
  const child = fakeChild();
  const killed = [];
  const res = await runBoundedProcessGroup(
    { bin: "/x/tool", args: [], cwd: "/x", timeoutMs: 10, defaultTimeoutMs: 99999 },
    { spawn: () => child, kill: (target, sig) => { killed.push([target, sig]); child.emit("close", null); } },
  );
  assert.deepEqual(killed, [[-4242, "SIGKILL"]]);
  assert.equal(res.timedOut, true);
  assert.equal(res.status, null);
  assert.equal(res.bound, 10);
});

test("COORD-486: a kill that throws (group already gone) is swallowed and the run still resolves", async () => {
  const child = fakeChild();
  const res = await runBoundedProcessGroup(
    { bin: "/x/tool", args: [], timeoutMs: 5, defaultTimeoutMs: 1 },
    {
      spawn: () => child,
      kill: () => { setImmediate(() => child.emit("close", null)); throw new Error("ESRCH"); },
    },
  );
  assert.equal(res.timedOut, true);
});

test("COORD-486: a non-numeric timeout falls back to the adapter's default bound", async () => {
  const child = fakeChild({ withPipes: false });
  const pending = runBoundedProcessGroup(
    { bin: "/x/tool", args: [], timeoutMs: "not-a-number", defaultTimeoutMs: 777 },
    { spawn: () => child },
  );
  child.emit("close", 0);
  const res = await pending;
  assert.equal(res.bound, 777);
  assert.equal(res.stdout, "", "a child without pipes yields empty output, not a crash");
  assert.equal(res.stderr, "");
});

test("COORD-486: a spawn throw resolves spawnError (never rejects) and carries the extra fields", async () => {
  const res = await runBoundedProcessGroup(
    { bin: "/x/missing", args: [], timeoutMs: 50, defaultTimeoutMs: 1, extra: { reportPath: "/x/r.json" } },
    { spawn: () => { throw new Error("ENOENT"); } },
  );
  assert.deepEqual(res, {
    status: null, timedOut: false, bound: 50, stdout: "", stderr: "Error: ENOENT", reportPath: "/x/r.json", spawnError: true,
  });
});

test("COORD-486: a child error event resolves with the error appended to stderr and the extra fields", async () => {
  const child = fakeChild();
  const pending = runBoundedProcessGroup(
    { bin: "/x/tool", args: [], timeoutMs: 5000, defaultTimeoutMs: 1, extra: { reportPath: "/x/r.json" } },
    { spawn: () => child },
  );
  child.stderr.emit("data", "partial");
  child.emit("error", new Error("EACCES"));
  assert.deepEqual(await pending, {
    status: null, timedOut: false, bound: 5000, stdout: "", stderr: "partial\nError: EACCES", reportPath: "/x/r.json",
  });
});

test("COORD-486: the extra fields ride on a normal close too", async () => {
  const child = fakeChild();
  const pending = runBoundedProcessGroup(
    { bin: "/x/tool", args: [], timeoutMs: 5000, defaultTimeoutMs: 1, extra: { reportPath: "/x/r.json" } },
    { spawn: () => child },
  );
  child.emit("close", 0);
  assert.equal((await pending).reportPath, "/x/r.json");
});

test("COORD-486: the default spawn/kill bound a real hung process group", { skip: process.platform === "win32" }, async () => {
  const started = Date.now();
  const res = await runBoundedProcessGroup({
    bin: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60000)"],
    cwd: __dirname,
    timeoutMs: 200,
    defaultTimeoutMs: 60000,
  });
  assert.equal(res.timedOut, true);
  assert.equal(res.status, null, "a SIGKILLed child has no exit status");
  assert.ok(Date.now() - started < 30000, "the bound, not the child's own 60s timer, ended the run");
});

test("COORD-486: the policy adapters delegate to the ONE shared runner (no private group-kill copy)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const adapters = {
    "sast-policy.js": "runSemgrepBounded",
    "mutation-policy.js": "runStrykerBounded",
    "supply-chain-policy.js": "runScannerBounded",
    "a11y-policy.js": "runA11yBounded",
    "perf-budget-policy.js": "runPerfBounded",
  };
  for (const [file, runner] of Object.entries(adapters)) {
    // COORD-867: mutation-policy stays at coord/scripts until batch 9; the resolver finds either home.
    const source = fs.readFileSync(resolveEngineModule(COORD_ROOT_DIR, "scripts/" + file), "utf8");
    assert.match(source, /require\((?:"\.\/bounded-process-runner\.js"|resolveEngineModule\([^)]*"scripts\/bounded-process-runner\.js"\))\)/, `${file} imports the shared runner`);
    assert.doesNotMatch(source, /-child\.pid/, `${file} carries no private process-group kill loop`);
    assert.equal(typeof require(resolveEngineModule(COORD_ROOT_DIR, "scripts/" + file))[runner], "function", `${file} keeps its public ${runner} seam`);
  }
});
