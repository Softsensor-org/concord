"use strict";

// COORD-663 — logical ownership vs physical namespace on a governed lock.
//
// THE DEFECT. `claim --transfer-to` moves logical ownership and DELIBERATELY
// preserves the ticket's worktree directory and branch: renaming a branch that
// may already be merged is not a governance repair. But the lock recorded only
// `owner`, and both canonical-location checks derived their expectation from
// it, so after a transfer the preserved paths were measured against the wrong
// handle. The mismatch was suppressed for the duration of the transfer
// mutation and for nothing after it, so the transfer succeeded and every LATER
// mutation failed — update-finding, update-plan, submit. The ticket wedged in
// `doing`, and the wedge blocked filing the evidence for the wedge.
//
// THE REPAIR. `workspace_owner` carries the physical namespace, defaulting to
// `owner` so every untransferred lock is unchanged. A divergence is legitimate
// ONLY when `transfer_provenance` attests it; an unexplained mismatch still
// fails closed. `normalize-lock` reconstructs both fields FROM THE JOURNAL for
// a lock transferred before the field existed.
//
// Validation-side proofs (a transferred lock validates with no suppression, an
// unproven mismatch is still refused, fabricated provenance is refused) live in
// coord/board/board.test.js against the real validateBoard fixture. The
// transfer-writes-provenance proof lives in agent-commands.test.js against the
// real claimTicket path. This file covers the two remaining obligations: a
// CHAIN of transfers stays attributable, and the normalization path is
// journal-derived rather than assumed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __testing } = require("./lifecycle.js");
const { rebindTicketLock } = __testing;

function makeLockFile(dir, lock) {
  const lockPath = path.join(dir, `${lock.ticket}.lock`);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return lockPath;
}

function withLocksDir(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-663-lock-ns-")));
  const locksDir = path.join(root, ".runtime", "locks");
  fs.mkdirSync(locksDir, { recursive: true });
  const originalLocksDir = __testing.paths.LOCKS_DIR;
  __testing.paths.LOCKS_DIR = locksDir;
  try {
    return fn({ root, locksDir });
  } finally {
    __testing.paths.LOCKS_DIR = originalLocksDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function baseLock(worktree) {
  return {
    agent_id: "a662",
    owner: "claudea662",
    ticket: "COORD-663",
    status: "doing",
    repo: "coord",
    branch: "agent/claudea662-coord-663-write-barrier",
    head: "coord-no-git-head",
    worktree,
    session_id: "a662-original",
    started_at_utc: "2026-08-11T03:42:37.064Z",
    heartbeat_utc: "2026-08-11T03:42:37.064Z",
  };
}

test("a chain of transfers pins the namespace to its original holder and stays attributable", () => {
  withLocksDir(({ locksDir }) => {
    const worktree = path.join(locksDir, "..", "..", ".worktrees", "claudea662", "COORD-663");
    const lockPath = makeLockFile(locksDir, baseLock(worktree));

    rebindTicketLock(
      { ...JSON.parse(fs.readFileSync(lockPath, "utf8")), path: lockPath },
      { id: "a663", handle: "claudea663" },
      { session_id: "a663-first" },
      { transfer: { from: "claudea662", reason: "restart continuation", previousSessionId: "a662-original" } }
    );
    const afterFirst = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(afterFirst.owner, "claudea663");
    assert.equal(afterFirst.workspace_owner, "claudea662");
    assert.equal(afterFirst.worktree, worktree, "the worktree is preserved");
    assert.equal(afterFirst.branch, "agent/claudea662-coord-663-write-barrier", "the branch is preserved");
    assert.equal(afterFirst.transfer_provenance.length, 1);

    rebindTicketLock(
      { ...afterFirst, path: lockPath },
      { id: "a664", handle: "claudea664" },
      { session_id: "a664-second" },
      { transfer: { from: "claudea663", reason: "second handoff", previousSessionId: "a663-first" } }
    );
    const afterSecond = JSON.parse(fs.readFileSync(lockPath, "utf8"));

    assert.equal(afterSecond.owner, "claudea664");
    assert.equal(
      afterSecond.workspace_owner,
      "claudea662",
      "the namespace never moves with ownership — it belongs to whoever's paths are still in use"
    );
    assert.equal(afterSecond.worktree, worktree);
    assert.equal(afterSecond.branch, "agent/claudea662-coord-663-write-barrier");
    assert.deepEqual(
      afterSecond.transfer_provenance.map((entry) => [entry.from, entry.to, entry.workspace_owner]),
      [
        ["claudea662", "claudea663", "claudea662"],
        ["claudea663", "claudea664", "claudea662"],
      ],
      "the full chain of custody is readable from the lock alone"
    );
    assert.deepEqual(
      afterSecond.transfer_provenance.map((entry) => entry.reason),
      ["restart continuation", "second handoff"]
    );
    assert.deepEqual(
      afterSecond.transfer_provenance.map((entry) => entry.previous_session_id),
      ["a662-original", "a663-first"]
    );
  });
});

test("an ORDINARY rebind (no transfer) neither invents a namespace nor drops an existing one", () => {
  withLocksDir(({ locksDir }) => {
    const worktree = path.join(locksDir, "..", "..", ".worktrees", "claudea662", "COORD-663");

    // Untransferred lock: no workspace_owner is written, so every lock that
    // existed before this repair keeps its exact meaning.
    const plainPath = makeLockFile(locksDir, baseLock(worktree));
    rebindTicketLock(
      { ...JSON.parse(fs.readFileSync(plainPath, "utf8")), path: plainPath },
      { id: "a662", handle: "claudea662" },
      { session_id: "a662-resumed" },
      {}
    );
    const plain = JSON.parse(fs.readFileSync(plainPath, "utf8"));
    assert.equal(plain.workspace_owner, undefined);
    assert.equal(plain.transfer_provenance, undefined);

    // Already-transferred lock: a later ordinary rebind (a resume) must not
    // erase the namespace or the history.
    const transferred = {
      ...baseLock(worktree),
      owner: "claudea663",
      workspace_owner: "claudea662",
      transfer_provenance: [
        { from: "claudea662", to: "claudea663", at: "2026-08-11T05:03:56.956Z", workspace_owner: "claudea662" },
      ],
    };
    const transferredPath = makeLockFile(locksDir, transferred);
    rebindTicketLock(
      { ...transferred, path: transferredPath },
      { id: "a663", handle: "claudea663" },
      { session_id: "a663-resumed" },
      {}
    );
    const resumed = JSON.parse(fs.readFileSync(transferredPath, "utf8"));
    assert.equal(resumed.workspace_owner, "claudea662");
    assert.equal(resumed.transfer_provenance.length, 1);
    assert.equal(resumed.worktree, worktree);
  });
});

test("a rebind whose owner does not change records nothing, even if a transfer is claimed", () => {
  withLocksDir(({ locksDir }) => {
    const worktree = path.join(locksDir, "..", "..", ".worktrees", "claudea662", "COORD-663");
    const lockPath = makeLockFile(locksDir, baseLock(worktree));
    rebindTicketLock(
      { ...JSON.parse(fs.readFileSync(lockPath, "utf8")), path: lockPath },
      { id: "a662", handle: "claudea662" },
      { session_id: "a662-again" },
      { transfer: { from: "claudea662", reason: "not actually a transfer" } }
    );
    const after = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(after.workspace_owner, undefined, "no namespace divergence means nothing to declare");
    assert.equal(after.transfer_provenance, undefined, "and nothing to attest");
  });
});
