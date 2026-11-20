"use strict";

// COORD-982 (ARCH-AUDIT F-03): the single `gh` spawn. Callers own their failure
// policy: landing-gh.js runGh throws on a non-zero exit, board-push-preflight
// createDefaultGh returns the raw result. Only options the caller supplies are
// passed to spawn, so each caller's spawn call is unchanged.

const { spawnSync } = require("node:child_process");

function spawnGh(args, options = {}) {
  const { spawn = spawnSync, cwd, env, timeoutMs, stdio, encoding = "utf8" } = options;
  const spawnOptions = { encoding };
  if (cwd) spawnOptions.cwd = cwd;
  if (env) spawnOptions.env = env;
  if (timeoutMs !== undefined) spawnOptions.timeout = timeoutMs;
  if (stdio !== undefined) spawnOptions.stdio = stdio;
  return spawn("gh", args, spawnOptions);
}

module.exports = { spawnGh };
