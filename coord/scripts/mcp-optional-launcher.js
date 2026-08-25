#!/usr/bin/env node
"use strict";

// COORD-483: optional network-backed MCP connectors are deliberately absent
// from the shipped .mcp.json. An adopter may copy a reviewed example and invoke
// this launcher; required credentials are checked before a package manager is
// allowed to start, and every package reference is immutable.

const childProcess = require("node:child_process");

const OPTIONAL_CONNECTORS = Object.freeze({
  sentry: Object.freeze({
    command: "npx",
    args: Object.freeze(["--yes", "@sentry/mcp-server@0.37.0"]),
    requiredEnv: Object.freeze(["SENTRY_ACCESS_TOKEN"]),
  }),
});

function resolveLaunch(name, env = process.env) {
  const connector = OPTIONAL_CONNECTORS[name];
  if (!connector) {
    throw new Error(
      `unknown optional MCP connector ${JSON.stringify(name || "")}; available: ${Object.keys(OPTIONAL_CONNECTORS).join(", ")}`
    );
  }
  const missing = connector.requiredEnv.filter((key) => !String(env[key] || "").trim());
  if (missing.length > 0) {
    throw new Error(
      `refusing to launch optional MCP connector ${name}: missing required environment variable(s): ${missing.join(", ")}`
    );
  }
  return {
    command: connector.command,
    args: [...connector.args],
    env,
  };
}

function run(argv = process.argv.slice(2), deps = {}) {
  const spawnSync = deps.spawnSync || childProcess.spawnSync;
  const env = deps.env || process.env;
  const err = deps.err || process.stderr;
  let launch;
  try {
    launch = resolveLaunch(argv[0], env);
  } catch (error) {
    err.write(`${error.message}\n`);
    return 2;
  }
  const result = spawnSync(launch.command, launch.args, {
    env: launch.env,
    stdio: "inherit",
  });
  if (result.error) {
    err.write(`optional MCP connector ${argv[0]} failed to start: ${result.error.message}\n`);
    return 1;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

module.exports = { OPTIONAL_CONNECTORS, resolveLaunch, run };

if (require.main === module) {
  process.exitCode = run();
}
