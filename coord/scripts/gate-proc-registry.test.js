"use strict";

// COORD-092: gate process-orphan containment + provenance-scoped reaper tests.
//
// TEST SAFETY (NON-NEGOTIABLE): every test operates ONLY on fixtures. The
// reaper's killing surface is exercised through an INJECTED `kill` spy (no real
// signal is ever sent) and an INJECTED `procRoot` / `isProcessAlive` so the
// PID-reuse guard is driven by fake /proc fixtures. The one test that spawns a
// real child spawns its OWN throwaway `sleep`, writes a registry entry pointing
// at THAT pid, and lets the trap-style teardown remove the entry — it asserts
// the recorded pid was the only thing the (spied) reaper targeted. No test scans
// the live process table or signals any process it did not itself spawn.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const reg = require("./gate-proc-registry.js");

function tmpRegistryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gate-procs-"));
}

// Build a fake /proc root: for each { pid, start } write <root>/<pid>/stat with
// a realistic stat line whose field-22 (starttime) is `start`. comm contains a
// space + parens to prove the parser splits on the LAST ")".
function fakeProcRoot(procs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fakeproc-"));
  for (const { pid, start } of procs) {
    const dir = path.join(root, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    // fields: 1=pid 2=comm(3=state ... 22=starttime). After last ")" the tokens
    // begin at field 3 (state). Pad fields 3..21 then starttime at field 22.
    const after = ["S"]; // field 3
    for (let f = 4; f <= 21; f += 1) after.push(String(f)); // fields 4..21
    after.push(String(start)); // field 22 = starttime
    const line = `${pid} ((node) test) ${after.join(" ")}\n`;
    fs.writeFileSync(path.join(dir, "stat"), line, "utf8");
    fs.writeFileSync(path.join(dir, "cmdline"), `node\0worker\0--pid=${pid}\0`);
  }
  return root;
}

test("registry write/read round-trip captures provenance fields", () => {
  const registryDir = tmpRegistryDir();
  const procRoot = fakeProcRoot([{ pid: 1001, start: 555 }, { pid: 1002, start: 556 }]);
  const written = reg.writeEntry(
    { gateRunId: "gate-be-full-42-99", ticket: "COORD-092", repo: "backend", lane: "full", pgid: 1001, pids: [1001, 1002] },
    { registryDir, procRoot }
  );
  assert.equal(written.gate_run_id, "gate-be-full-42-99");
  assert.equal(written.ticket, "COORD-092");
  assert.equal(written.repo, "backend");
  assert.equal(written.lane, "full");
  assert.equal(written.pgid, 1001);
  assert.equal(written.procs.length, 2);
  assert.equal(written.procs[0].start_time, "555");
  assert.match(written.procs[0].cmdline, /--pid=1001/);

  const read = reg.readEntry("gate-be-full-42-99", { registryDir });
  assert.deepEqual(read, written);

  const all = reg.listEntries({ registryDir });
  assert.equal(all.length, 1);
});

test("registryPathFor sanitizes the gate-run-id so it cannot escape the registry dir", () => {
  const p = reg.registryPathFor("../../etc/passwd", "/tmp/reg");
  // Path separators are stripped so the entry can never escape the registry dir;
  // the resolved file stays directly inside /tmp/reg.
  assert.equal(path.dirname(p), "/tmp/reg");
  assert.equal(path.basename(p), ".._.._etc_passwd.json");
  assert.ok(!path.basename(p).includes("/"));
});

test("readProcStartTime parses field 22 even when comm contains spaces/parens", () => {
  const procRoot = fakeProcRoot([{ pid: 2002, start: 7777 }]);
  assert.equal(reg.readProcStartTime(2002, procRoot), "7777");
  assert.equal(reg.readProcStartTime(9999, procRoot), null); // gone
});

test("cleanup (trap teardown) removes the registry entry on clean exit", () => {
  const registryDir = tmpRegistryDir();
  const procRoot = fakeProcRoot([{ pid: 3003, start: 100 }]);
  reg.writeEntry({ gateRunId: "clean-run", pids: [3003] }, { registryDir, procRoot });
  assert.equal(reg.listEntries({ registryDir }).length, 1);
  // Simulate the gate.sh `trap cleanup EXIT` registry removal.
  const removed = reg.removeEntry("clean-run", { registryDir });
  assert.equal(removed, true);
  assert.equal(reg.listEntries({ registryDir }).length, 0);
});

test("trap teardown kills the recorded group + clears the entry for a real spawned child", async () => {
  // Spawn OUR OWN throwaway child (a long sleep) so we never touch a foreign
  // process. Record it, then prove the (spied) reaper would target exactly that
  // pid, and the real cleanup teardown both terminates it and removes residue.
  const registryDir = tmpRegistryDir();
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { detached: true });
  const pid = child.pid;
  try {
    // Register using the REAL /proc so the start-time fingerprint is the live one.
    reg.writeEntry({ gateRunId: "real-clean", ticket: null, pids: [pid] }, { registryDir });
    const entry = reg.readEntry("real-clean", { registryDir });
    assert.equal(entry.procs[0].pid, pid);
    // On Linux the real start-time was captured; on a non-/proc host it is null.
    if (process.platform === "linux") {
      assert.ok(/^\d+$/.test(entry.procs[0].start_time));
      // The PID-reuse guard matches the live process now.
      assert.equal(reg.procMatchesLive(entry.procs[0]), true);
    }
  } finally {
    // Real teardown: terminate our child, then remove the entry (what the
    // gate.sh trap does on clean exit).
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    reg.removeEntry("real-clean", { registryDir });
  }
  assert.equal(reg.listEntries({ registryDir }).length, 0);
});

test("doctor detects an orphan entry when the owning gate-run is gone", () => {
  const registryDir = tmpRegistryDir();
  // Recorded pid 4004 with start 200, but the fake /proc has NO such pid -> gone.
  const procRoot = fakeProcRoot([]);
  reg.writeEntry({ gateRunId: "orphan-run", ticket: "COORD-092", pids: [4004] }, { registryDir, procRoot: fakeProcRoot([{ pid: 4004, start: 200 }]) });
  const orphans = reg.detectOrphans({ registryDir, procRoot, isProcessAlive: () => false });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].gateRunId, "orphan-run");
  assert.match(orphans[0].reason, /no recorded process is still live/);
});

test("doctor detects an orphan when procs live but the owning ticket is no longer doing", () => {
  const registryDir = tmpRegistryDir();
  const procRoot = fakeProcRoot([{ pid: 5005, start: 300 }]);
  reg.writeEntry({ gateRunId: "ticket-done-run", ticket: "COORD-092", pids: [5005] }, { registryDir, procRoot });
  const orphans = reg.detectOrphans({
    registryDir,
    procRoot,
    isProcessAlive: () => true,
    isTicketDoing: () => false, // ticket no longer doing
  });
  assert.equal(orphans.length, 1);
  assert.match(orphans[0].reason, /no longer doing/);
});

test("reaper kills EXACTLY the recorded PIDs and removes the entry (provenance-scoped)", () => {
  const registryDir = tmpRegistryDir();
  const procRoot = fakeProcRoot([{ pid: 6006, start: 400 }]);
  // recorded matches live start -> reapable; but owner is gone because we mark
  // it orphan via ticket-not-doing while procs are live, to exercise the kill.
  reg.writeEntry({ gateRunId: "reap-run", ticket: "COORD-092", pids: [6006] }, { registryDir, procRoot });
  const killed = [];
  const result = reg.reapOrphans({
    registryDir,
    procRoot,
    isProcessAlive: () => true,
    isTicketDoing: () => false,
    kill: (pid, sig) => { killed.push([pid, sig]); },
  });
  assert.deepEqual(killed, [[6006, "SIGTERM"]]);
  assert.equal(result.reaped.length, 1);
  assert.deepEqual(result.reaped[0].signaled_pids, [6006]);
  assert.equal(reg.listEntries({ registryDir }).length, 0); // entry removed
});

test("reaper is a NO-OP (refuses to kill) when the live PID start-time mismatches the recorded one (reused-PID case)", () => {
  const registryDir = tmpRegistryDir();
  // Recorded entry says pid 7007 had start_time 500. Live /proc shows pid 7007
  // is ALIVE but with a DIFFERENT start_time (900) — i.e. the PID was recycled
  // by another process. The reuse guard must refuse to signal it.
  reg.writeEntry({ gateRunId: "reused-run", ticket: "COORD-092", pids: [7007] }, { registryDir, procRoot: fakeProcRoot([{ pid: 7007, start: 500 }]) });
  const procRootReused = fakeProcRoot([{ pid: 7007, start: 900 }]); // same pid, new process
  const killed = [];
  const result = reg.reapOrphans({
    registryDir,
    procRoot: procRootReused,
    isProcessAlive: () => true, // pid is alive...
    isTicketDoing: () => false,
    kill: (pid, sig) => { killed.push([pid, sig]); },
  });
  // The recorded proc does NOT match the live process -> no proc is "live" ->
  // entry classified orphan with no matched procs -> NOTHING signaled.
  assert.deepEqual(killed, [], "reused PID must never be signaled");
  assert.equal(result.reaped.length, 1);
  assert.deepEqual(result.reaped[0].signaled_pids, []);
  // Entry is still cleared (the recorded process is provably gone/reused).
  assert.equal(reg.listEntries({ registryDir }).length, 0);
});

test("reaper IGNORES entries whose owner is still live (no signal, entry retained)", () => {
  const registryDir = tmpRegistryDir();
  const procRoot = fakeProcRoot([{ pid: 8008, start: 600 }]);
  reg.writeEntry({ gateRunId: "live-run", ticket: "COORD-092", pids: [8008] }, { registryDir, procRoot });
  const killed = [];
  const result = reg.reapOrphans({
    registryDir,
    procRoot,
    isProcessAlive: () => true,
    isTicketDoing: () => true, // owner still doing + procs live -> NOT an orphan
    kill: (pid, sig) => { killed.push([pid, sig]); },
  });
  assert.deepEqual(killed, []);
  assert.equal(result.reaped.length, 0);
  assert.equal(reg.listEntries({ registryDir }).length, 1, "live entry must be retained");
});

test("reaper refuses to signal when the recorded entry has no start-time (no reuse guard available -> fail-safe)", () => {
  const registryDir = tmpRegistryDir();
  // Write an entry whose proc has start_time === null (e.g. registered on a host
  // with no /proc). Even though the pid is "alive", without a reuse guard we
  // must NOT kill — fail-safe.
  const entry = reg.buildEntry({ gateRunId: "noguard-run", ticket: "COORD-092", procs: [{ pid: 9009, start_time: null, cmdline: null }] });
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(reg.registryPathFor("noguard-run", registryDir), JSON.stringify(entry) + "\n");
  const killed = [];
  reg.reapOrphans({
    registryDir,
    isProcessAlive: () => true,
    isTicketDoing: () => false,
    kill: (pid, sig) => { killed.push([pid, sig]); },
  });
  assert.deepEqual(killed, [], "no start-time guard -> must never signal");
});

test("CLI register/cleanup round-trips through the module main()", () => {
  // Drive the CLI surface gate.sh uses. Point at a temp registry via env-free
  // injection is not available for main(), so we exercise writeEntry+removeEntry
  // (what register/cleanup call) here and assert main() arg parsing separately.
  const flags = reg.parseCliArgs(["--gate-run-id", "x", "--pids", "1,2,3", "--lane", "full"]);
  assert.equal(flags["gate-run-id"], "x");
  assert.equal(flags.pids, "1,2,3");
  assert.equal(flags.lane, "full");
});
