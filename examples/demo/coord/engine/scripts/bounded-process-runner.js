"use strict";

// COORD-486: the ONE bounded process-group runner shared by the policy adapters
// (sast / mutation / supply-chain / a11y / perf-budget). Each adapter used to
// carry a byte-identical copy of this COORD-129 process-group-kill loop; they
// now keep only their tool-specific argv and delegate here.
//
// Spawns `bin args` as its OWN process GROUP ({ detached: true }) so a
// negative-pid SIGKILL on timeout reaches the whole tree (workers, headless
// browsers, VUs), bounds it with a timer, and SIGKILLs the group on timeout.
// Resolves { status, timedOut, bound, stdout, stderr, ...extra } and NEVER
// rejects on a hung or unspawnable tool: a spawn throw resolves with
// spawnError:true, a hung tool with timedOut:true. `extra` is merged into every
// result (mutation-policy carries its reportPath through). `deps.spawn` /
// `deps.kill` are injectable so tests prove the timeout path without the tool.

const { spawn } = require("child_process");

function runBoundedProcessGroup(
  { bin, args, cwd, timeoutMs, defaultTimeoutMs, extra = {} } = {},
  deps = {},
) {
  const spawnImpl = deps.spawn || spawn;
  const killImpl = deps.kill || ((target, sig) => process.kill(target, sig));
  const bound = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : defaultTimeoutMs;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, {
        cwd,
        detached: true, // own process group → negative-pid kill reaches the tree
        env: process.env,
      });
    } catch (err) {
      resolve({ status: null, timedOut: false, bound, stdout: "", stderr: String(err), ...extra, spawnError: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    if (child.stdout) child.stdout.on("data", (d) => { stdout += d; });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      // Negative pid = the whole process group: kills the tool AND its
      // grandchildren, releasing the inherited pipes so we never block.
      try { killImpl(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, bound);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, timedOut, bound, stdout, stderr, ...extra });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, timedOut, bound, stdout, stderr: `${stderr}\n${err}`, ...extra });
    });
  });
}

module.exports = { runBoundedProcessGroup };
