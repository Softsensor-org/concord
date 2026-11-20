"use strict";

// COORD-994 / COORD-1005: the one kill mechanism for every harness child a test crashes or
// times out. Each child is spawned detached, so it leads its own process group and a group
// signal reaches the child AND anything it spawned (no orphans). A crash is a group SIGKILL
// (a hard crash, nothing can catch it). Teardown escalates SIGTERM -> SIGKILL.
// Shared by crash-window.test.js and integration-authority.test.js.

const fs = require("node:fs");
const { once } = require("node:events");
const { spawn } = require("node:child_process");

function spawnKillable(args, options = {}) {
  return spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, ...options });
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

// Timeout escalation: SIGTERM the group, then SIGKILL it after a grace period. The group can
// outlive its leader, so SIGKILL is always sent even after the leader has exited.
async function killGroup(child, graceMs = 500) {
  if (child.exitCode === null && child.signalCode === null) {
    signalGroup(child, "SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, graceMs))]);
  }
  signalGroup(child, "SIGKILL");
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  try {
    return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

// Child side: publish the fault point the child reached, then block until the parent kills the
// group. The marker is written atomically (temp file, then rename) so the parent never reads a
// half-written file. `payload` is merged into the marker (for example, a grandchild pid).
function holdAt(reachedPath, payload = {}) {
  const tmp = `${reachedPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...payload, pid: process.pid }), "utf8");
  fs.renameSync(tmp, reachedPath);
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(cell, 0, 0, 50);
}

// Parent side: run `args` in a detached child that calls holdAt(reachedPath). Once the child has
// reached its hold point, SIGKILL its process group (a crash) and resolve with what it left
// behind. A child that exits before reaching its hold point resolves with its own status, so the
// caller's assertions report it. A child that never reaches the hold point is torn down with
// killGroup (SIGTERM, then SIGKILL) and the call throws.
// `beforeKill(reached)` runs while the child is still blocked at its hold point, before the group
// is signalled, so a caller can check what the child left running (for example, a grandchild).
async function crashAtHold(args, { cwd, env, reachedPath, timeoutMs = 30000, beforeKill = null }) {
  fs.rmSync(reachedPath, { force: true });
  const child = spawnKillable(args, { cwd, env });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const settled = await waitUntil(() => fs.existsSync(reachedPath) || child.exitCode !== null || child.signalCode !== null, timeoutMs);
  if (!settled) {
    await killGroup(child);
    throw new Error(`child never reached its hold point: ${stderr}`);
  }
  const reached = fs.existsSync(reachedPath);
  if (reached && beforeKill) await beforeKill(JSON.parse(fs.readFileSync(reachedPath, "utf8")));
  if (reached) signalGroup(child, "SIGKILL");
  const { code, signal } = await exited;
  return {
    status: code,
    signal,
    stderr,
    reached: reached ? JSON.parse(fs.readFileSync(reachedPath, "utf8")) : null,
  };
}

module.exports = { spawnKillable, signalGroup, killGroup, isAlive, waitUntil, holdAt, crashAtHold };
