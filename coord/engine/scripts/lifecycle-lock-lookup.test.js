"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createLockLookup = require("./lifecycle-lock-lookup.js");

// COORD-820: the lock lookup moved out of lifecycle.js unchanged. Pin the
// precedence (first directory wins per file name), the .lock filter, the
// sorted order, the identity normalization and the not-found result.
test("COORD-820: lock lookup enumerates lock dirs in precedence order and finds a ticket's normalized lock", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "coord820-lock-lookup-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const primary = path.join(base, "locks");
  const legacy = path.join(base, "legacy");
  fs.mkdirSync(primary);
  fs.mkdirSync(legacy);
  const write = (dir, name, payload) => fs.writeFileSync(path.join(dir, name), JSON.stringify(payload));
  write(primary, "B-2.lock", { ticket: "B-2", owner: "alias-b" });
  write(primary, "A-1.lock", { ticket: "A-1", owner: "alias-a" });
  write(legacy, "A-1.lock", { ticket: "A-1", owner: "shadowed" });
  write(legacy, "C-3.lock", { ticket: "C-3", owner: "alias-c" });
  fs.writeFileSync(path.join(primary, "notes.txt"), "not a lock");

  const normalized = [];
  const { getLockFiles, findLockForTicket } = createLockLookup({
    existingLockDirs: () => [primary, legacy],
    normalizeLockIdentityReferences: (lock) => {
      normalized.push(lock && lock.ticket);
      return lock && { ...lock, owner: String(lock.owner).replace(/^alias-/, "handle-") };
    },
    safeReadJson: (file) => JSON.parse(fs.readFileSync(file, "utf8")),
  });

  assert.deepEqual(getLockFiles(), [
    path.join(primary, "A-1.lock"),
    path.join(primary, "B-2.lock"),
    path.join(legacy, "C-3.lock"),
  ]);
  assert.deepEqual(findLockForTicket("A-1"), { path: path.join(primary, "A-1.lock"), ticket: "A-1", owner: "handle-a" });
  assert.deepEqual(findLockForTicket("C-3"), { path: path.join(legacy, "C-3.lock"), ticket: "C-3", owner: "handle-c" });
  assert.equal(findLockForTicket("Z-9"), null);
  assert.ok(normalized.includes("B-2"), "every candidate lock is identity-normalized before matching");
});

test("COORD-820: lock lookup skips an unreadable lock instead of matching it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord820-lock-unreadable-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "A-1.lock"), "{ torn");
  const { getLockFiles, findLockForTicket } = createLockLookup({
    existingLockDirs: () => [dir],
    normalizeLockIdentityReferences: (lock) => lock,
    safeReadJson: () => null,
  });
  assert.deepEqual(getLockFiles(), [path.join(dir, "A-1.lock")]);
  assert.equal(findLockForTicket("A-1"), null);
});
