"use strict";

// COORD-992 (ARCH-AUDIT F-06): the one pid and start-time liveness primitive. Lock, lease and
// executor decisions ask these facts here. Each caller keeps its own policy for "unknown" and
// "different" (fail closed, or PID-only when /proc is unavailable). Dependency-free, so any
// sibling engine module can require it without a cycle.

const fs = require("node:fs");
const path = require("node:path");

// kill(pid, 0). Only ESRCH means gone; EPERM means the pid exists under another user.
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === "ESRCH");
  }
}

// Field 22 (starttime) of /proc/<pid>/stat, parsed from the LAST ")" so comm may contain spaces
// or parentheses. Null when /proc is unreadable, the pid is gone, or the field is not numeric.
function readProcStartTime(pid, procRoot = "/proc") {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let raw;
  try {
    raw = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
  } catch {
    return null;
  }
  const rparen = raw.lastIndexOf(")");
  if (rparen === -1) return null;
  // After the last ")" the tokens start at field 3 (state), so starttime is index 22 - 3 = 19.
  const starttime = raw.slice(rparen + 1).trim().split(/\s+/)[19];
  return starttime !== undefined && /^\d+$/.test(starttime) ? starttime : null;
}

// Process state character from /proc/<pid>/stat ("Z" is a zombie). Null when unreadable.
function readProcState(pid, procRoot = "/proc") {
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    return raw.slice(raw.lastIndexOf(")") + 2).charAt(0);
  } catch {
    return null;
  }
}

// Three-way answer for a recorded start time against the live process. "unknown" whenever either
// side is missing; the caller decides what unknown means.
function startTimeVerdict(pid, recordedStart, readStart = readProcStartTime) {
  const live = readStart(pid);
  if (recordedStart == null || live == null) return "unknown";
  return String(live) === String(recordedStart) ? "same" : "different";
}

// True only when the pid is alive AND its live start time matches the recorded one. This is the
// PID-reuse guard: a recycled pid has a different start time and is never the recorded process.
function isSameProcess(pid, startTime, options = {}) {
  const alive = typeof options.isProcessAlive === "function" ? options.isProcessAlive : isProcessAlive;
  if (!alive(pid)) return false;
  const readStart = (p) => readProcStartTime(p, options.procRoot || "/proc");
  return startTimeVerdict(pid, startTime, readStart) === "same";
}

// COORD-1003: the one owner-liveness verdict for lock wording, lock reclaim and doctor recovery.
// "dead": gone, a zombie, or a reused pid (its live start time differs from the recorded one).
// "live": alive, not a zombie, and the live start time matches the recorded one.
// "unknown": alive by pid, but the start time cannot be compared (no recorded start time, or /proc
// unreadable). Callers keep their PID-only behaviour; unknown is never reported or treated as dead.
function ownerLiveness(pid, recordedStart, options = {}) {
  const alive = typeof options.isProcessAlive === "function" ? options.isProcessAlive : isProcessAlive;
  if (!alive(pid)) return "dead";
  const procRoot = options.procRoot || "/proc";
  const state = typeof options.readProcessState === "function" ? options.readProcessState(pid) : readProcState(pid, procRoot);
  if (state === "Z") return "dead";
  const readStart = typeof options.readProcessStartTime === "function"
    ? options.readProcessStartTime
    : (p) => readProcStartTime(p, procRoot);
  const verdict = startTimeVerdict(pid, recordedStart, readStart);
  if (verdict === "different") return "dead";
  return verdict === "same" ? "live" : "unknown";
}

// COORD-931: namespace-independent owner identity. A PID means something only inside one boot and
// one PID namespace. Unreadable values are omitted, which makes the owner "unverifiable".
function readBootId() {
  try {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readPidNamespace() {
  try {
    return fs.readlinkSync("/proc/self/ns/pid");
  } catch {
    return null;
  }
}

function readOwnerIdentity(pid) {
  const identity = {};
  const bootId = readBootId();
  const pidNs = readPidNamespace();
  const startTime = readProcStartTime(pid);
  if (bootId !== null) identity.boot_id = bootId;
  if (pidNs !== null) identity.pid_ns = pidNs;
  if (startTime !== null) identity.pid_start_time = startTime;
  return identity;
}

module.exports = {
  isProcessAlive,
  isSameProcess,
  ownerLiveness,
  readBootId,
  readOwnerIdentity,
  readPidNamespace,
  readProcStartTime,
  readProcState,
  startTimeVerdict,
};
