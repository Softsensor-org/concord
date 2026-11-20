"use strict";

// COORD-992 (ARCH-AUDIT F-06): the one pid and start-time liveness primitive.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const identity = require("./process-identity.js");

// A pid that is provably gone: a real child that was spawned and reaped (never a constant).
function deadPid() {
  const reaped = spawnSync(process.execPath, ["-e", ""]);
  return reaped.pid;
}

// A fake /proc root with one stat file per pid. Field 22 (starttime) sits at index 19 after the
// last ")", so comm may contain spaces and parentheses.
function fakeProcRoot(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord992-proc-"));
  for (const { pid, start, comm = "fake proc", state = "S" } of entries) {
    fs.mkdirSync(path.join(dir, String(pid)));
    const fields = Array(19).fill("0");
    fields[0] = state;
    fs.writeFileSync(path.join(dir, String(pid), "stat"), `${pid} (${comm}) ${fields.join(" ")} ${start} 0 0\n`);
  }
  return dir;
}

function withTempProcRoot(entries, fn) {
  const dir = fakeProcRoot(entries);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("COORD-992: isProcessAlive is true for self and for pid 1 (EPERM counts as alive), false for a reaped child", () => {
  assert.equal(identity.isProcessAlive(process.pid), true);
  assert.equal(identity.isProcessAlive(1), true, "pid 1 exists; EPERM from another user is alive");
  assert.equal(identity.isProcessAlive(deadPid()), false, "only ESRCH is gone");
});

test("COORD-992: isProcessAlive refuses non-positive and non-integer pids", () => {
  for (const pid of [0, -1, "1", 1.5, null, undefined]) {
    assert.equal(identity.isProcessAlive(pid), false, `pid ${String(pid)}`);
  }
});

test("COORD-992: readProcStartTime parses field 22 even when comm contains spaces and parentheses", () => {
  withTempProcRoot([{ pid: 2002, start: 7777, comm: "weird ) name (x" }], (root) => {
    assert.equal(identity.readProcStartTime(2002, root), "7777");
  });
});

test("COORD-992: readProcStartTime is null when the pid is gone, /proc is unreadable, or the stat has no comm close", () => {
  withTempProcRoot([{ pid: 3003, start: 1 }], (root) => {
    assert.equal(identity.readProcStartTime(4004, root), null, "gone");
  });
  assert.equal(identity.readProcStartTime(5005, path.join(os.tmpdir(), "coord992-no-such-proc")), null, "unreadable /proc");
  assert.equal(identity.readProcStartTime(-1, "/proc"), null, "invalid pid");
  const malformed = fakeProcRoot([]);
  fs.mkdirSync(path.join(malformed, "6006"));
  fs.writeFileSync(path.join(malformed, "6006", "stat"), "6006 no-comm-close S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 9\n");
  try {
    assert.equal(identity.readProcStartTime(6006, malformed), null, "no ')' means no parseable field 22");
  } finally {
    fs.rmSync(malformed, { recursive: true, force: true });
  }
});

test("COORD-992: startTimeVerdict is same, different, or unknown; unknown whenever either side is missing", () => {
  withTempProcRoot([{ pid: 7007, start: 500 }], (root) => {
    const read = (pid) => identity.readProcStartTime(pid, root);
    assert.equal(identity.startTimeVerdict(7007, "500", read), "same");
    assert.equal(identity.startTimeVerdict(7007, "501", read), "different", "a recycled pid has a different start time");
    assert.equal(identity.startTimeVerdict(7007, null, read), "unknown", "no recorded start time");
    assert.equal(identity.startTimeVerdict(7007, undefined, read), "unknown", "no recorded start time");
    assert.equal(identity.startTimeVerdict(8008, "500", read), "unknown", "live start time unreadable");
  });
});

test("COORD-992: isSameProcess needs a live pid AND a matching start time; any unknown fails closed", () => {
  withTempProcRoot([{ pid: 9009, start: 42 }], (root) => {
    const alive = () => true;
    assert.equal(identity.isSameProcess(9009, "42", { procRoot: root, isProcessAlive: alive }), true);
    assert.equal(identity.isSameProcess(9009, "43", { procRoot: root, isProcessAlive: alive }), false, "reused pid is not the process");
    assert.equal(identity.isSameProcess(9009, null, { procRoot: root, isProcessAlive: alive }), false, "no recorded start time");
    assert.equal(identity.isSameProcess(9009, "42", { procRoot: path.join(os.tmpdir(), "coord992-missing"), isProcessAlive: alive }), false, "unreadable /proc fails closed");
    assert.equal(identity.isSameProcess(9009, "42", { procRoot: root, isProcessAlive: () => false }), false, "not alive");
  });
});

test("COORD-992: readOwnerIdentity reports boot id, PID namespace and start time for self, and omits what is unreadable", () => {
  const self = identity.readOwnerIdentity(process.pid);
  assert.equal(typeof self.pid_start_time, "string");
  assert.match(self.pid_start_time, /^\d+$/);
  const realReadFile = fs.readFileSync;
  fs.readFileSync = function patched(file, ...rest) {
    if (typeof file === "string" && file === `/proc/${process.pid}/stat`) {
      const error = new Error(`EACCES: ${file}`);
      error.code = "EACCES";
      throw error;
    }
    return realReadFile.call(fs, file, ...rest);
  };
  try {
    assert.equal("pid_start_time" in identity.readOwnerIdentity(process.pid), false, "unreadable stat omits start time");
  } finally {
    fs.readFileSync = realReadFile;
  }
});

test("COORD-992: readProcState returns the state character, or null when unreadable", () => {
  withTempProcRoot([{ pid: 1111, start: 1, state: "Z" }], (root) => {
    assert.equal(identity.readProcState(1111, root), "Z");
  });
  assert.equal(identity.readProcState(1111, path.join(os.tmpdir(), "coord992-missing")), null);
});

// COORD-1003: one owner-liveness verdict for lock wording, lock reclaim and doctor recovery.
// dead = gone, a zombie, or a reused pid (different start time); live = same process; unknown =
// alive by pid but the start time cannot be compared, so no caller may treat it as dead.
test("COORD-1003: ownerLiveness is live for the same process, dead for a reused pid, unknown when the start time is unreadable", () => {
  withTempProcRoot([{ pid: 1212, start: 500 }], (root) => {
    const alive = () => true;
    assert.equal(identity.ownerLiveness(1212, "500", { procRoot: root, isProcessAlive: alive }), "live");
    assert.equal(identity.ownerLiveness(1212, "501", { procRoot: root, isProcessAlive: alive }), "dead", "a reused pid is not the recorded process");
    assert.equal(identity.ownerLiveness(1212, null, { procRoot: root, isProcessAlive: alive }), "unknown", "no recorded start time is not dead");
    assert.equal(identity.ownerLiveness(1212, "500", { procRoot: path.join(os.tmpdir(), "coord1003-missing"), isProcessAlive: alive }), "unknown", "unreadable /proc is not dead");
    assert.equal(identity.ownerLiveness(1212, "500", { procRoot: root, isProcessAlive: () => false }), "dead", "a pid that is gone is dead");
  });
});

test("COORD-1003: ownerLiveness counts a zombie as dead whether or not the start time matches", () => {
  withTempProcRoot([{ pid: 1313, start: 500, state: "Z" }], (root) => {
    const alive = () => true;
    assert.equal(identity.ownerLiveness(1313, "500", { procRoot: root, isProcessAlive: alive }), "dead", "a zombie has exited and cannot run");
    assert.equal(identity.ownerLiveness(1313, null, { procRoot: root, isProcessAlive: alive }), "dead", "zombie is dead even with an unknown start time");
  });
});

test("COORD-1003: ownerLiveness takes injected readers, and uses the real /proc for self", () => {
  assert.equal(identity.ownerLiveness(process.pid, identity.readProcStartTime(process.pid)), "live");
  assert.equal(identity.ownerLiveness(process.pid, "1"), "dead", "self with a different start time is a reused pid");
  assert.equal(identity.ownerLiveness(process.pid, identity.readProcStartTime(process.pid), { readProcessState: () => "Z" }), "dead");
  assert.equal(identity.ownerLiveness(process.pid, "1", { readProcessStartTime: () => "1" }), "live", "injected start time wins");
});

test("COORD-1052: a malformed proc start time cannot identify a reused PID", () => {
  withTempProcRoot([{ pid: 1414, start: "invalid" }], (procRoot) => {
    assert.equal(identity.readProcStartTime(1414, procRoot), null);
    const options = { procRoot, isProcessAlive: () => true };
    assert.equal(identity.ownerLiveness(1414, "42", options), "unknown");
    assert.equal(identity.isSameProcess(1414, "42", options), false);
  });
});

test("COORD-1052: unavailable kernel identifiers are omitted independently of PID start time", (t) => {
  const startTime = identity.readProcStartTime(process.pid);
  const bootPath = "/proc/sys/kernel/random/boot_id";
  const namespacePath = "/proc/self/ns/pid";
  const realRead = fs.readFileSync;
  const realReadLink = fs.readlinkSync;
  let bootFileMissing = false;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file !== bootPath) return realRead(file, ...args);
    if (!bootFileMissing) return "\n";
    return realRead(path.join(os.devNull, "boot_id"), ...args);
  });
  t.mock.method(fs, "readlinkSync", (file, ...args) => {
    if (file !== namespacePath) return realReadLink(file, ...args);
    return realReadLink(path.join(os.devNull, "pid"), ...args);
  });
  const expected = startTime === null ? {} : { pid_start_time: startTime };
  assert.deepEqual(identity.readOwnerIdentity(process.pid), expected, "empty boot ID is omitted");
  bootFileMissing = true;
  assert.deepEqual(identity.readOwnerIdentity(process.pid), expected, "unreadable boot ID is omitted");
});
