"use strict";
// COORD-1020: test-only, in-process equivalent of the fixture CLI spawn
// `node <root>/coord/scripts/governance.js <args>` with cwd=<root> and the fixture env.
// The fixture's own engine copy is loaded from its absolute path after the require
// cache for <root>/coord is purged, so its module graph is separate from the canonical
// checkout and from every previous run. Nothing here is loaded by production code.
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

const SESSION_KEYS = ["NODE_TEST_CONTEXT", "NODE_CHANNEL_FD", "COORD_SESSION_ID", "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID", "AGENT_THREAD_ID", "COORD_AGENT_ID", "COORD_AGENT_HANDLE", "COORD_OWNER"];

class ExitSignal extends Error {
  constructor(code) { super(`process.exit(${code})`); this.exitCode = code; }
}

function purgeCoordCache(coordDir) {
  const prefix = coordDir + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) delete require.cache[key];
  }
}

// env: the complete environment the CLI child would receive. Session keys must be
// absent from it; the runner deletes them from the copy so the in-process env matches.
function runFixtureGovernance(root, args, env, approvalClient) {
  const coordDir = path.join(root, "coord");
  const entry = path.join(coordDir, "scripts", "governance.js");
  const childEnv = { ...env };
  for (const key of SESSION_KEYS) delete childEnv[key];

  const saved = {
    env: { ...process.env }, argv: process.argv, cwd: process.cwd(), exitCode: process.exitCode,
    exit: process.exit, log: console.log, error: console.error, warn: console.warn,
    stdoutWrite: process.stdout.write, stderrWrite: process.stderr.write,
  };
  const stdout = [];
  const stderr = [];
  const capture = (sink) => (...values) => { sink.push(`${util.format(...values)}\n`); };
  const writer = (sink) => (chunk, encoding, callback) => {
    sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : "utf8"));
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done();
    return true;
  };

  purgeCoordCache(coordDir);
  let status = 0;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, childEnv);
    process.chdir(root);
    process.argv = [process.execPath, entry, ...args];
    process.exitCode = undefined;
    process.exit = (code) => { throw new ExitSignal(code === undefined ? (process.exitCode ?? 0) : code); };
    console.log = capture(stdout);
    console.error = capture(stderr);
    console.warn = capture(stderr);
    process.stdout.write = writer(stdout);
    process.stderr.write = writer(stderr);
    try {
      const run = () => require(entry).main();
      if (approvalClient) {
        const { withApprovalTestClient } = require(path.join(coordDir, "engine", "scripts", "__fixtures__", "approval-test-client.js"));
        withApprovalTestClient(coordDir, approvalClient, run);
      } else {
        run();
      }
      status = process.exitCode ?? 0;
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error;
      status = error.exitCode;
    }
  } finally {
    process.exit = saved.exit;
    console.log = saved.log;
    console.error = saved.error;
    console.warn = saved.warn;
    process.stdout.write = saved.stdoutWrite;
    process.stderr.write = saved.stderrWrite;
    process.chdir(saved.cwd);
    process.argv = saved.argv;
    process.exitCode = saved.exitCode;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved.env);
    purgeCoordCache(coordDir);
  }
  // signal: an in-process run cannot be killed by a signal, so spawnSync's null is the equal value.
  // An uncaught exception is rethrown, not converted: the CLI child's Node banner is not reproducible.
  return { status, signal: null, stdout: stdout.join(""), stderr: stderr.join("") };
}

module.exports = { runFixtureGovernance, SESSION_KEYS };
