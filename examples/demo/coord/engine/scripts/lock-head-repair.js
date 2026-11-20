"use strict";

// COORD-978: `gov repair-lock-head <ID>` realigns a ticket's lock head with its worktree HEAD.
//
// Authority (human-admin decision 2026-11-13): the ticket's owner may repair only to a commit
// that contains every head already recorded for the ticket (its lock head, its review
// submission commit, its PR head and its finding heads). Any other repair needs
// --human-admin-override "<reason>", and the override reason is journaled.
//
//   gov repair-lock-head <ID> --dry-run                        read-only preview; always allowed
//   gov repair-lock-head <ID> --to <sha> --expect <digest>     apply (digest from the preview)
//   gov repair-lock-head <ID> --to <sha> --expect <digest> --human-admin-override "<reason>"
//
// Apply runs inside withGovernanceMutation: the lock write and the journal event commit as one
// governed mutation, and a retry with the same digest is an idempotent no-op once journaled
// (crash-safe retry, following the integration-authority recover/resume pattern).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = path.resolve(__dirname, "..", "..");
const { state, GovernanceError } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-context.js"));
const authority = require("./integration-authority.js");
const { gitTry } = require("./git-ops.js");
const approvalVerifier = require("./approval-verifier.js");

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const NO_HEAD = new Set(["coord-no-git-head"]);

function fail(message) {
  // guard:lock-normalization
  throw new GovernanceError(message);
}

function readJsonOr(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ticketRow(board, ticketId) {
  for (const section of board.sections || []) {
    for (const row of section.rows || []) {
      if (row && row.ID === ticketId) return row;
    }
  }
  return null;
}

// Every head already recorded for the ticket: the lock head, the review submission commit,
// the PR head(s) on the board, and any finding heads. Duplicates collapse; order is stable.
function recordedHeads(ticketId, lock, board, planRecord) {
  const heads = [];
  const add = (kind, commit) => {
    const value = typeof commit === "string" ? commit.trim().toLowerCase() : "";
    if (!value || NO_HEAD.has(value)) return;
    if (!heads.some((entry) => entry.commit === value)) heads.push({ kind, commit: value });
  };
  add("lock_head", lock.head);
  add("review_submission", planRecord?.review_submission?.commit);
  const prRefs = Array.isArray(board.pr_index?.[ticketId]) ? board.pr_index[ticketId] : [];
  for (const ref of prRefs) {
    if (!ref || typeof ref !== "object") continue;
    add("pr_head", ref.head_sha || ref.headRefOid || ref.head);
  }
  const findings = Array.isArray(board.review_findings?.[ticketId]) ? board.review_findings[ticketId] : [];
  for (const finding of findings) {
    if (!finding || typeof finding !== "object") continue;
    add("finding_head", finding.commit || finding.head);
  }
  return heads;
}

// Containment: `git merge-base --is-ancestor <recorded> <target>` for every recorded head.
function containment(worktree, heads, target) {
  return heads.map((entry) => {
    const present = gitTry(worktree, ["cat-file", "-e", `${entry.commit}^{commit}`]).status === 0;
    if (!present) return { ...entry, contains: false, reason: "recorded head is not present in the worktree repository" };
    const ancestor = gitTry(worktree, ["merge-base", "--is-ancestor", entry.commit, target]);
    if (ancestor.status === 0) return { ...entry, contains: true, reason: null };
    if (ancestor.status === 1) return { ...entry, contains: false, reason: "target does not contain this recorded head" };
    return { ...entry, contains: false, reason: `merge-base failed: ${String(ancestor.stderr || "").trim()}` };
  });
}

function digestOf(snapshot) {
  const canonical = JSON.stringify({
    ticket: snapshot.ticket,
    owner: snapshot.lock.owner,
    lock_head: snapshot.lock.head,
    lock_branch: snapshot.lock.branch,
    worktree_branch: snapshot.worktree_branch,
    worktree_head: snapshot.worktree_head,
    target: snapshot.target,
    recorded_heads: snapshot.recorded.map((entry) => `${entry.kind}:${entry.commit}`).sort(),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function snapshotFor(ticketId, options = {}) {
  const lockPath = path.join(state.LOCKS_DIR, `${ticketId}.lock`);
  if (!fs.existsSync(lockPath)) fail(`Ticket ${ticketId} has no governed lock; nothing to repair.`);
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const board = JSON.parse(fs.readFileSync(state.BOARD_PATH, "utf8"));
  const row = ticketRow(board, ticketId);
  if (!row) fail(`Unknown ticket "${ticketId}".`);
  const worktree = lock.worktree;
  const liveHead = gitTry(worktree, ["rev-parse", "HEAD"]);
  if (liveHead.status !== 0) fail(`Ticket ${ticketId} lock points to worktree without a readable git HEAD.`);
  const worktreeHead = liveHead.stdout.trim();
  const worktreeBranch = gitTry(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const planRecord = readJsonOr(path.join(state.PLAN_RECORDS_DIR, `${ticketId}.json`), null);
  const recorded = recordedHeads(ticketId, lock, board, planRecord);
  const target = (options.to || worktreeHead).toLowerCase();
  const snapshot = { ticket: ticketId, lock, lockPath, worktree, worktree_head: worktreeHead, worktree_branch: worktreeBranch, target, recorded };
  snapshot.containment = containment(worktree, recorded, worktreeHead);
  snapshot.digest = digestOf(snapshot);
  return snapshot;
}

function authorityVerdict(snapshot, caller, override) {
  const owner = snapshot.lock.owner;
  const allContain = snapshot.containment.every((entry) => entry.contains);
  const ownerMatch = Boolean(caller) && caller === owner;
  if (ownerMatch && allContain) return { path: "owner", allowed: true, reason: "owner repair to a commit that contains every recorded head" };
  if (override) return { path: "human-admin-override", allowed: true, reason: "human-admin override; journaled with its reason" };
  const why = !ownerMatch ? `caller ${caller || "(unbound)"} is not the owner ${owner}` : "target does not contain every recorded head";
  return {
    path: "blocked",
    allowed: false,
    reason: `${why}; owner repair needs a containing commit, anything else needs --human-admin-override "<reason>"`,
  };
}

function previewPayload(snapshot, verdict) {
  return {
    ticket: snapshot.ticket,
    status: "preview",
    writes: "none",
    lock: { head: snapshot.lock.head, branch: snapshot.lock.branch, owner: snapshot.lock.owner, worktree: snapshot.worktree },
    worktree: { head: snapshot.worktree_head, branch: snapshot.worktree_branch },
    target: snapshot.target,
    recorded_heads: snapshot.recorded,
    containment: snapshot.containment,
    authority: verdict,
    expected_state_digest: snapshot.digest,
    next_commands: verdict.allowed
      ? [`coord/scripts/gov repair-lock-head ${snapshot.ticket} --to ${snapshot.target} --expect ${snapshot.digest}`]
      : [`coord/scripts/gov repair-lock-head ${snapshot.ticket} --to ${snapshot.target} --expect ${snapshot.digest} --human-admin-override "<reason>"`],
  };
}

function createLockHeadRepair({ withGovernanceMutation, resolveHumanAdminOverride, appendGovernanceEvent, runtimeDir }) {
  function repairLockHead(ticketId, flags = {}) {
    if (!ticketId) fail("repair-lock-head requires <ticket-id>.");
    const caller = authority.resolveCaller()?.handle || null;
    const override = typeof flags.humanAdminOverride === "string" ? flags.humanAdminOverride.trim() : "";
    const snapshot = snapshotFor(ticketId, { to: typeof flags.to === "string" ? flags.to : null });

    if (flags.dryRun) {
      console.log(JSON.stringify(previewPayload(snapshot, authorityVerdict(snapshot, caller, override)), null, 2));
      return { status: "preview" };
    }

    if (typeof flags.expect !== "string" || !flags.expect) {
      // guard:lock-normalization
      fail(`repair-lock-head ${ticketId} applies only against a previewed state: run "coord/scripts/gov repair-lock-head ${ticketId} --dry-run" and pass its expected_state_digest as --expect.`);
    }
    if (!/^[0-9a-f]{64}$/.test(flags.expect)) {
      // guard:lock-normalization
      fail("repair-lock-head --expect must be a 64-hex expected_state_digest from the preview.");
    }
    const mutation = {
      command: "repair-lock-head",
      ticket: ticketId,
      allowProvenanceDrift: true,
      idempotencyKey: `repair-lock-head:${ticketId}:${snapshot.target}:${flags.expect}`,
      idempotentResult: { status: "already-repaired", ticket: ticketId, to: snapshot.target },
    };
    // Every check runs INSIDE the journaled mutation, after crash recovery has restored any
    // interrupted lock write. A retry therefore re-verifies against the restored state.
    return withGovernanceMutation(mutation, () => {
      const current = snapshotFor(ticketId, { to: snapshot.target });
      if (!SHA.test(current.target)) {
        // guard:lock-normalization
        fail(`repair-lock-head --to must be a full commit SHA; got "${current.target}".`);
      }
      if (current.lock.branch !== current.worktree_branch) {
        // guard:lock-normalization
        fail(`repair-lock-head ${ticketId}: lock branch ${current.lock.branch} does not match worktree branch ${current.worktree_branch}; the branch precondition fails and nothing was written.`);
      }
      if (current.target !== current.worktree_head) {
        // guard:lock-normalization
        fail(`repair-lock-head ${ticketId}: --to ${current.target} is not the live worktree HEAD ${current.worktree_head}; a repair only aligns the lock with the worktree HEAD. Move the worktree through governed verbs first.`);
      }
      if (current.digest !== flags.expect) {
        // guard:lock-normalization
        fail(`repair-lock-head ${ticketId} refused: expected state changed since the preview (digest ${flags.expect} != ${current.digest}). Rerun the preview; nothing was written.`);
      }
      if (current.lock.head === current.target) {
        // guard:lock-normalization
        fail(`repair-lock-head ${ticketId}: the lock head already equals ${current.target}; nothing to repair.`);
      }
      const verdict = authorityVerdict(current, caller, override);
      if (!verdict.allowed) {
        // guard:lock-normalization
        fail(`repair-lock-head ${ticketId} refused: ${verdict.reason}. Nothing was written.`);
      }
      const approval = verdict.path === "human-admin-override"
        ? approvalVerifier.requireSignedOverride({ commandName: "repair-lock-head", ticketId,
          row: { ticket: ticketId, lock: current.lock, worktree: { head: current.worktree_head, branch: current.worktree_branch },
            target: current.target, recorded_heads: current.recorded, containment: current.containment, expected_state_digest: current.digest },
          options: { humanAdminOverride: override },
          deps: { resolveHumanAdminOverride, fail, appendGovernanceEvent, runtimeDir } })
        : null;
      const lock = current.lock;
      const from = lock.head;
      lock.head = current.target;
      fs.writeFileSync(current.lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      // Crash seam for the crash-safe retry test: the lock is written, the journal event is not.
      if (process.env.COORD_LOCK_HEAD_REPAIR_FAULT === "after-lock-write") process.exit(86);
      mutation.details = {
        from,
        to: current.target,
        authority: verdict.path,
        owner: lock.owner,
        caller,
        human_admin_override: verdict.path === "human-admin-override" ? override : null,
        approval: approval?.approval || null,
        containment: current.containment,
        expected_state_digest: current.digest,
      };
      const result = { status: "repaired", ticket: ticketId, from, to: current.target, authority: verdict.path };
      console.log(JSON.stringify(result, null, 2));
      return result;
    });
  }
  return { repairLockHead, __testing: { snapshotFor, recordedHeads, containment, digestOf, authorityVerdict } };
}

module.exports = { createLockHeadRepair };
