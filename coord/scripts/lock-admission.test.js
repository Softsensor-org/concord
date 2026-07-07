"use strict";

// COORD-437: admission-control invariants for the directory-lock layer. The mkdir
// runtime lock is the correctness authority that keeps a SECOND governed journal
// writer from being admitted. These tests pin the invariants that (a) a live
// holder is never displaced by age, (b) a genuinely-dead owner's stale lock is
// still recoverable, and (c) lock metadata is written atomically so a concurrent
// reader can't catch a torn file and mis-classify a live lock as ownerless.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ctx = require("./governance-context.js");

function tmpLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockadm-"));
  const lock = path.join(dir, "the.lock");
  fs.mkdirSync(lock);
  return { dir, lock };
}

test("COORD-437: writeDirectoryLockMetadata is atomic — complete JSON, round-trips, no temp lingers", () => {
  const { dir, lock } = tmpLock();
  try {
    ctx.writeDirectoryLockMetadata(lock, { kind: "test" });
    const meta = ctx.readDirectoryLockMetadata(lock);
    assert.ok(meta && Number.isInteger(meta.pid), "metadata must carry a pid");
    assert.equal(meta.kind, "test");
    const raw = fs.readFileSync(ctx.directoryLockMetadataPath(lock), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw), "metadata file must always be complete JSON");
    const strays = fs.readdirSync(lock).filter((n) => n.includes(".tmp-"));
    assert.deepEqual(strays, [], "no temp metadata file may linger after the atomic write");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-437: a lock held by a LIVE local pid is NEVER reclaimed by age", () => {
  const { dir, lock } = tmpLock();
  try {
    // Owned by THIS process (alive) and aged well past the staleness threshold.
    ctx.writeDirectoryLockMetadata(lock, { kind: "governance-runtime" });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    // staleMs=1 => stale by age, but the owner is alive => admission is refused.
    assert.equal(ctx.tryReclaimStaleDirectoryLock(lock, 1), false);
    assert.ok(fs.existsSync(lock), "the live holder's lock must still be held");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-437: a stale lock owned by a DEAD pid is reclaimable (recovery is preserved)", () => {
  const { dir, lock } = tmpLock();
  try {
    fs.writeFileSync(
      ctx.directoryLockMetadataPath(lock),
      JSON.stringify({ pid: 2 ** 30, host: os.hostname(), kind: "governance-runtime" }) + "\n"
    );
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    assert.equal(ctx.tryReclaimStaleDirectoryLock(lock, 1), true, "a dead owner's stale lock is reclaimable");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
