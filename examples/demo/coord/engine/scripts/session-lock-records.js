"use strict";
const fs = require("fs");
const path = require("path");
const { STATUS } = require("./governance-constants.js");
const { spawnSync } = require("node:child_process");
const { resolveIntegrationBaseRef } = require("./integration-base-ref.js");

// Keep lock payload, owner-transfer provenance and legacy/v2 behavior behind
// the existing session facade. These dependencies retain its live state object.
module.exports = function createSessionLockRecords({ normalizeOwnerValue, repoNameForCode,
  resolveLockHead, resolveAgentIdentifier, readAgentsRegistry, state, ensureParentDir,
  identityV2, moveFileIfNeeded }) {
// COORD-898 (2): the commit the ticket worktree was cut from, recorded on the lock
// so the submit delta is measured from that immutable commit, not from a local ref
// that may lag or lead origin. Null when it cannot be proven (no git worktree yet).
function resolveLockBaseCommit(worktree, baseRef) {
  if (!worktree || !baseRef || !fs.existsSync(worktree)) {
    return null;
  }
  try {
    const { ref } = resolveIntegrationBaseRef(worktree, baseRef);
    const result = spawnSync("git", ["-C", worktree, "merge-base", "HEAD", ref], { encoding: "utf8" });
    const sha = String(result.stdout || "").trim();
    return result.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// COORD-920: `workspaceOwner` names the owner whose namespace holds a preserved PR
// worktree when that differs from `owner`; `transferProvenance` carries the transfer history.
function writeLock({ ticketId, owner, repoCode, branch, worktree, now, repoName, session, baseRef, workspaceOwner = null, transferProvenance = null }) {
  const canonicalOwner = normalizeOwnerValue(owner);
  const timestamp = now || new Date().toISOString();
  const repo = repoName || repoNameForCode(repoCode);
  const head = resolveLockHead(repoCode, worktree);
  const agent = resolveAgentIdentifier(canonicalOwner, readAgentsRegistry())?.agent || null;
  const activeSession =
    session?.status === "active" &&
    session.board_path === state.BOARD_PATH &&
    session.handle === canonicalOwner
      ? session
      : null;
  const lockPath = path.join(state.LOCKS_DIR, `${ticketId}.lock`);
  ensureParentDir(lockPath);
  // GCV-1 Phase-6 lock-write migration (O5): under the durable v2 channel
  // the lock is OWNER-authoritative — it no longer emits session_id as an
  // authority field, and is tagged identity_model:"v2" so readers/doctor
  // know the absence is intentional. When the channel is absent, the
  // legacy session_id binding is preserved verbatim (fleet-safe; GCV-1
  // deletes nothing and old locks stay fully readable).
  const v2Channel = identityV2.readEnvIdentity().present;
  const lockPayload = {
    agent_id: agent?.id || null,
    owner: canonicalOwner,
    ticket: ticketId,
    status: STATUS.DOING,
    repo,
    branch,
    head,
    worktree,
    base_commit: resolveLockBaseCommit(worktree, baseRef),
    session_id: v2Channel ? null : activeSession?.session_id || null,
    started_at_utc: timestamp,
    heartbeat_utc: timestamp,
  };
  if (v2Channel) {
    lockPayload.identity_model = "v2";
  }
  if (typeof workspaceOwner === "string" && workspaceOwner.trim() && normalizeOwnerValue(workspaceOwner) !== canonicalOwner) {
    lockPayload.workspace_owner = normalizeOwnerValue(workspaceOwner);
    lockPayload.transfer_provenance = Array.isArray(transferProvenance) ? transferProvenance : [];
  }
  fs.writeFileSync(lockPath, `${JSON.stringify(lockPayload, null, 2)}\n`, "utf8");
}

function isCompleteLockPayload(lock) {
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
    return false;
  }
  const requiredFields = [
    "ticket",
    "status",
    "repo",
    "branch",
    "head",
    "worktree",
    "started_at_utc",
  ];
  return requiredFields.every((field) => typeof lock[field] === "string" && lock[field].trim().length > 0);
}

// COORD-663: `options.transfer` marks a rebind that changes LOGICAL ownership.
// A transfer deliberately preserves the physical worktree and branch, so the
// namespace stays with the previous owner and must be recorded as such —
// otherwise every later mutation validates the preserved paths against the new
// owner and the ticket wedges. `{ from, reason, previousSessionId }`.
function rebindTicketLock(lock, agent, session, options = {}) {
  if (!lock?.path) {
    return null;
  }
  const nextPath = moveFileIfNeeded(lock.path, path.join(state.LOCKS_DIR, path.basename(lock.path)));
  // GCV-1 Phase-6: a rebind must not DOWNGRADE a v2 owner-authoritative
  // lock back to a legacy session-authority lock. If the durable channel
  // is present or the lock is already identity_model:"v2", keep it
  // owner-authoritative (session_id null, v2 tag retained).
  const v2Lock = identityV2.readEnvIdentity().present || lock.identity_model === "v2";
  const next = {
    ...lock,
    agent_id: agent?.id || null,
    owner: agent?.handle || lock.owner,
    session_id: v2Lock ? null : session?.session_id || null,
    heartbeat_utc: new Date().toISOString(),
  };
  if (v2Lock) {
    next.identity_model = "v2";
  }
  // COORD-663. `workspace_owner` and `transfer_provenance` ride on `...lock`
  // for every ordinary rebind, so a previously transferred lock keeps both. A
  // rebind that CHANGES the owner pins the namespace to whoever held it and
  // appends one attributable history entry.
  const transfer = options.transfer && typeof options.transfer === "object" ? options.transfer : null;
  const previousOwner = typeof transfer?.from === "string" ? transfer.from.trim() : "";
  const namespaceOwner =
    (typeof lock.workspace_owner === "string" && lock.workspace_owner.trim()) || lock.owner;
  if (previousOwner && next.owner && previousOwner !== next.owner) {
    next.workspace_owner = namespaceOwner;
    next.transfer_provenance = [
      ...(Array.isArray(lock.transfer_provenance) ? lock.transfer_provenance : []),
      {
        from: previousOwner,
        to: next.owner,
        at: new Date().toISOString(),
        workspace_owner: namespaceOwner,
        reason: typeof transfer.reason === "string" && transfer.reason.trim() ? transfer.reason.trim() : null,
        previous_session_id: transfer.previousSessionId || null,
      },
    ];
  }
  delete next.path;
  fs.writeFileSync(nextPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return {
    path: nextPath,
    session_id: session?.session_id || null,
    owner: agent?.handle || lock.owner,
  };
}


  return { writeLock, isCompleteLockPayload, rebindTicketLock };
};
