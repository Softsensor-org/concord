"use strict";

// COORD-663 (requirement 5) — the governed normalization path for a lock that
// was transferred BEFORE `workspace_owner` existed.
//
// Such a lock names the new owner while its worktree and branch still occupy
// the previous owner's namespace, so every mutation fails the canonical
// location checks and the ticket is wedged: it cannot record findings, update
// its plan, or submit. Hand-editing the lock is never the remedy. This path
// reconstructs the namespace and the transfer provenance FROM THE JOURNAL, and
// refuses whenever the journal does not support the reconstruction — an
// unexplained mismatch is not a normalization case.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  __testing,
  executeCommand,
  setupCoord003Workspace,
} = require("./governance-test-utils.js");

delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

const NAMESPACE_OWNER = "claudea0000";
const NEW_OWNER = "claudea0001";

function readLock(ctx) {
  return JSON.parse(fs.readFileSync(ctx.lockPath, "utf8"));
}

function writeLock(ctx, lock) {
  fs.writeFileSync(ctx.lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

// Materialize the pre-repair wedge: ownership already moved on the board and
// the lock, the physical namespace still belongs to the previous owner, and
// nothing on the lock records that a transfer happened. This is exactly what
// every `claim --transfer-to` produced before this ticket.
function materializeLegacyTransfer(ctx, ticketId, { journalTransfer = true } = {}) {
  const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
  board.sections[0].rows.find((row) => row.ID === ticketId).Owner = NEW_OWNER;
  fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

  const lock = readLock(ctx);
  delete lock.workspace_owner;
  delete lock.transfer_provenance;
  writeLock(ctx, { ...lock, owner: NEW_OWNER });

  if (journalTransfer) {
    const eventLogPath = path.join(ctx.coordRoot, ".runtime", "governance-events.ndjson");
    const event = {
      ts: "2026-08-11T05:03:56.956Z",
      command: "claim-ticket",
      ticket: ticketId,
      result: "succeeded",
      before_status: "doing",
      after_status: "doing",
      identity: { agent_id: "a0001", owner: NEW_OWNER },
      details: {
        previous_owner: NAMESPACE_OWNER,
        previous_session_id: `${NAMESPACE_OWNER}-prior`,
        transfer_to: NEW_OWNER,
        override_reason: "human-admin authorized continuation after a session restart",
      },
      changed_paths: [],
    };
    fs.appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  // The engine seals the board against out-of-band edits. This fixture
  // materializes state the REPAIRED engine can no longer produce (a transfer
  // that left no namespace record), so the seal is re-anchored exactly as a
  // fresh journal baseline would — fixture setup, not a sanctioned way to
  // mutate a live board.
  __testing.appendGovernanceEvent({
    ts: new Date().toISOString(),
    command: "journal-baseline",
    ticket: null,
    before_status: null,
    after_status: null,
    identity: null,
    details: { reason: "COORD-663 normalize-lock fixture: materialized a pre-repair transferred lock" },
    changed_paths: [],
    snapshot: __testing.buildGovernanceSnapshot(),
  });
}

test("normalize-lock reconstructs the namespace and provenance from the journal, leaving the worktree and branch untouched", () => {
  const ticketId = "MSRV-663";
  const ctx = setupCoord003Workspace("coord663-normalize-ok-", ticketId, NAMESPACE_OWNER, {
    ticketStatus: "doing",
    withCommit: true,
  });
  try {
    const before = readLock(ctx);
    materializeLegacyTransfer(ctx, ticketId);

    const result = executeCommand(["normalize-lock", ticketId]);
    assert.equal(result.ok, true, `normalize-lock should have succeeded; got: ${result.error}`);

    const after = readLock(ctx);
    assert.equal(after.owner, NEW_OWNER, "logical ownership is untouched by normalization");
    assert.equal(after.workspace_owner, NAMESPACE_OWNER, "the namespace is recovered from the journal");
    assert.equal(after.worktree, before.worktree, "the worktree is NOT renamed");
    assert.equal(after.branch, before.branch, "the branch is NOT renamed");

    assert.equal(after.transfer_provenance.length, 1);
    const [entry] = after.transfer_provenance;
    assert.equal(entry.from, NAMESPACE_OWNER);
    assert.equal(entry.to, NEW_OWNER);
    assert.equal(entry.workspace_owner, NAMESPACE_OWNER);
    assert.equal(entry.at, "2026-08-11T05:03:56.956Z", "the timestamp is the journal's, not now()");
    assert.match(entry.reason, /human-admin/);
    assert.equal(entry.previous_session_id, `${NAMESPACE_OWNER}-prior`);

    // Idempotent: a second run reports the existing record instead of
    // appending a duplicate transfer.
    const second = executeCommand(["normalize-lock", ticketId]);
    assert.equal(second.ok, true);
    assert.equal(readLock(ctx).transfer_provenance.length, 1);
  } finally {
    ctx.restore();
  }
});

test("normalize-lock REFUSES a namespace mismatch with no transfer behind it", () => {
  const ticketId = "MSRV-663";
  const ctx = setupCoord003Workspace("coord663-normalize-nojournal-", ticketId, NAMESPACE_OWNER, {
    ticketStatus: "doing",
    withCommit: true,
  });
  try {
    // Same divergent state, but nothing in the journal transferred this
    // ticket. A lock that merely SITS in the wrong namespace is an unexplained
    // mismatch, and inventing provenance for it would manufacture evidence.
    materializeLegacyTransfer(ctx, ticketId, { journalTransfer: false });

    const result = executeCommand(["normalize-lock", ticketId]);
    assert.equal(result.ok, false, "normalize-lock must fail closed");
    assert.match(result.error, /no recorded ownership transfer/);
    assert.match(result.error, /must keep failing closed/);

    const after = readLock(ctx);
    assert.equal(after.workspace_owner, undefined, "nothing is written on a refusal");
    assert.equal(after.transfer_provenance, undefined);
  } finally {
    ctx.restore();
  }
});

test("normalize-lock REFUSES when the journal's namespace contradicts the lock's physical path", () => {
  const ticketId = "MSRV-663";
  const ctx = setupCoord003Workspace("coord663-normalize-contradiction-", ticketId, NAMESPACE_OWNER, {
    ticketStatus: "doing",
    withCommit: true,
  });
  try {
    materializeLegacyTransfer(ctx, ticketId);
    // The journal says the namespace belongs to claudea0000, but the lock's
    // worktree points somewhere else entirely. Reconstructing from the journal
    // here would write a namespace the paths do not use.
    const lock = readLock(ctx);
    writeLock(ctx, { ...lock, worktree: path.join(ctx.coordRoot, ".worktrees", "claudea9999", ticketId) });

    const result = executeCommand(["normalize-lock", ticketId]);
    assert.equal(result.ok, false);
    assert.match(result.error, /is not inside that namespace/);
    assert.equal(readLock(ctx).workspace_owner, undefined);
  } finally {
    ctx.restore();
  }
});

test("normalize-lock REFUSES when the journal's transfer chain does not end at the lock's owner", () => {
  const ticketId = "MSRV-663";
  const ctx = setupCoord003Workspace("coord663-normalize-wrongowner-", ticketId, NAMESPACE_OWNER, {
    ticketStatus: "doing",
    withCommit: true,
  });
  try {
    materializeLegacyTransfer(ctx, ticketId);
    // The journal records a FURTHER transfer away from the lock's owner. The
    // chain therefore ends somewhere the lock does not, and reconstructing
    // from it would attest a custody history this lock does not have.
    const eventLogPath = path.join(ctx.coordRoot, ".runtime", "governance-events.ndjson");
    fs.appendFileSync(eventLogPath, `${JSON.stringify({
      ts: "2026-08-11T06:00:00.000Z",
      command: "claim-ticket",
      ticket: ticketId,
      result: "succeeded",
      before_status: "doing",
      after_status: "doing",
      identity: { agent_id: "a7777", owner: "claudea7777" },
      details: { previous_owner: NEW_OWNER, transfer_to: "claudea7777", override_reason: "onward transfer" },
      changed_paths: [],
    })}\n`, "utf8");

    const result = executeCommand(["normalize-lock", ticketId]);
    assert.equal(result.ok, false);
    assert.match(result.error, /ends at owner/);
    assert.equal(readLock(ctx).workspace_owner, undefined);
  } finally {
    ctx.restore();
  }
});
