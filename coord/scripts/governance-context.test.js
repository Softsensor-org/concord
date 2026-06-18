"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __testing } = require("./governance-test-utils.js");

// COORD-100 (governance.test residual split, capstone): behavior tests whose
// primary subject is DEFINED in governance-context.js — the stale directory
// lock reclaimer (tryReclaimStaleDirectoryLock). Exercised through the
// fully-wired `__testing` facade.


test("tryReclaimStaleDirectoryLock reclaims only stale directory locks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-stale-lock-"));
  const staleLock = path.join(tempDir, "stale.lock");
  const freshLock = path.join(tempDir, "fresh.lock");
  const deadOwnerLock = path.join(tempDir, "dead-owner.lock");
  fs.mkdirSync(staleLock, { recursive: true });
  fs.mkdirSync(freshLock, { recursive: true });
  fs.mkdirSync(deadOwnerLock, { recursive: true });
  fs.writeFileSync(path.join(deadOwnerLock, "lock-owner.json"), JSON.stringify({
    pid: 999999,
    created_at: new Date().toISOString(),
  }, null, 2));
  const staleAt = new Date(Date.now() - 120_000);
  fs.utimesSync(staleLock, staleAt, staleAt);

  assert.equal(__testing.tryReclaimStaleDirectoryLock(staleLock, 60_000), true);
  assert.equal(fs.existsSync(staleLock), false);
  assert.equal(__testing.tryReclaimStaleDirectoryLock(freshLock, 60_000), false);
  assert.equal(fs.existsSync(freshLock), true);
  assert.equal(__testing.tryReclaimStaleDirectoryLock(deadOwnerLock, 60_000), true);
  assert.equal(fs.existsSync(deadOwnerLock), false);
});
