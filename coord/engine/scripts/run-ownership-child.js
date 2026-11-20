"use strict";

// COORD-905: real-process fixture for the owned-resource manifest. A test spawns
// THIS file as a child "runner". It begins a run, creates an owned temp dir and a
// marker-tagged grandchild process, prints one READY JSON line, and then blocks.
// The parent sends SIGTERM/SIGINT (graceful path) or SIGKILL (crash path). Every
// directory and process here lives under the sandbox dir passed on argv.
//
// Usage: node run-ownership-child.js <sandboxDir>

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const runOwnership = require("./run-ownership.js");

const sandbox = path.resolve(process.argv[2]);
const runsDir = path.join(sandbox, "runs");
const handle = runOwnership.beginRun({ dir: runsDir, kind: "fixture-runner" });
runOwnership.installSignalHandlers(handle);

const tempDir = path.join(sandbox, `owned-temp-${handle.runId.slice(0, 8)}`);
handle.recordTempDir(tempDir);

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  env: { ...process.env, ...handle.env },
});
handle.recordProcessMarker();

function onUnexpectedChildEnd() {
  handle.release();
  process.exitCode = 1;
}
grandchild.once("error", onUnexpectedChildEnd);
grandchild.once("exit", onUnexpectedChildEnd);
grandchild.once("spawn", () => {
  process.stdout.write(`${JSON.stringify({ ready: true, runId: handle.runId, tempDir, grandchildPid: grandchild.pid, runsDir })}\n`);
});
