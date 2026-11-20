"use strict";

// COORD-922: the read-only preview behind `gov claim <ticket> --transfer-to
// <handle> --human-admin-override "<reason>" --dry-run`.
//
// Before this, claimTicket never read --dry-run, so the "preview" performed the
// real transfer. The preview runs the same authorization checks as the real
// transfer (ticket state, context-pack acknowledgement, registered active
// target, the human-admin override, the missing-lock live-owner probe) and then
// reports what the transfer WOULD change. It opens no governed mutation, binds
// no session, takes no state lock and writes no file: board, journal, locks,
// sessions, plans and rendered views stay byte-identical.
const path = require("node:path");
const { assertStoredContextPackAckValid } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/context-pack-ack-contract.js"));
// COORD-920: the preview reads the same PR workspace evidence the real transfer checks.
const { assertReviewWorkspaceTransferable } = require("./review-workspace-evidence.js");
// ADR 0031 (COORD-1034): a preview never treats the override string as authorization.
const { approvalRequirement } = require("./approval-verifier.js");
const { approvalActor, buildClaimTransferApprovalState } = require("./claim-transfer-approval-state.js");

const NOT_PREVIEWED = Object.freeze([
  "the target session binding on this runtime thread (claim-agent session reuse or creation)",
  "the runtime provider match for the target agent",
]);

function previewClaimTransfer(ticketId, options, deps) {
  const { fail, state, STATUS, readBoard, getTicketRef, isDoingStatus, canonicalizeOwnerOrFail, readAgentsRegistry,
    resolveAgentIdentifier, findLockForTicket, detectActiveSameOwnerOtherThread, buildActiveSameOwnerOtherThreadMessage,
    currentRuntimeThreadId, resolveHumanAdminOverride, readAgentSessions, detectRuntimeProvider, identityV2, COORD_DIR } = deps;
  if (!options.transferTo) {
    fail(`claim --dry-run previews an owner transfer only: pass --transfer-to <handle> --human-admin-override "<reason>". A plain claim has no read-only preview; use \`coord/scripts/gov ticket ${ticketId}\` to inspect it.`);
  }
  const board = readBoard();
  const ref = getTicketRef(board, ticketId);
  if (!ref) fail(`Unknown ticket "${ticketId}".`);
  assertStoredContextPackAckValid(ticketId, { state, fail, verb: "claim --transfer-to" });
  const status = ref.row.Status;
  if ([STATUS.TODO, STATUS.DEFERRED].includes(status) || !ref.row.Owner || ref.row.Owner === "unassigned") {
    fail(`Ticket ${ticketId} is ${status} under owner ${ref.row.Owner || "unassigned"}: there is no claimed ticket to transfer. Use \`coord/scripts/gov start ${ticketId}\` instead.`);
  }
  const previousOwner = canonicalizeOwnerOrFail(ref.row.Owner, { readOnly: true });
  const target = resolveAgentIdentifier(options.transferTo, readAgentsRegistry({ readOnly: true }));
  if (!target) fail(`Unknown registered agent "${options.transferTo}".`);
  if (target.agent.status !== "active") fail(`Agent ${target.agent.handle} (${target.agent.id}) is not active.`);
  const targetOwner = target.agent.handle;
  if (targetOwner === previousOwner) {
    fail(`Ticket ${ticketId} is already owned by ${previousOwner}: --transfer-to names the current owner, so there is no transfer to preview.`);
  }
  // The reason is required (same refusal as before) and is shown only as text. It authorizes nothing.
  const reasonText = resolveHumanAdminOverride("claim --transfer-to", options).reason;
  const lock = findLockForTicket(ticketId);
  // COORD-920: a review ticket holds no lock; its PR workspace is checked exactly as the real transfer checks it.
  const preserved = lock ? null : assertReviewWorkspaceTransferable({ isOwnerTransfer: true, ticketId, row: ref.row, currentOwner: previousOwner, prRefs: board.pr_index?.[ticketId], fail });
  const preservedWorkspace = preserved
    ? { worktree: preserved.worktree, branch: preserved.branch, pr_head: preserved.pr_head, pr_url: preserved.pr_url, workspace_owner: preserved.workspace_owner }
    : null;
  const recreateLock = !lock && isDoingStatus(status);
  if (recreateLock) {
    const liveOwner = detectActiveSameOwnerOtherThread(
      ticketId,
      { owner: previousOwner, status: STATUS.DOING, session_id: null },
      { currentThreadId: currentRuntimeThreadId() }
    );
    if (liveOwner.present) fail(buildActiveSameOwnerOtherThreadMessage(ticketId, liveOwner, options));
  }
  const workspaceOwnerBefore = (lock && typeof lock.workspace_owner === "string" && lock.workspace_owner.trim()) || null;
  const namespaceOwner = workspaceOwnerBefore || (lock ? lock.owner : previousOwner);
  const priorProvenance = lock && Array.isArray(lock.transfer_provenance) ? lock.transfer_provenance.length : 0;
  const previousSessionId = lock?.session_id || null;
  const sessions = readAgentSessions({ readOnly: true });
  const currentThreadId = currentRuntimeThreadId();
  const currentThreadSession = sessions.find((session) => session.thread_id === currentThreadId &&
    session.board_path === state.BOARD_PATH && session.status === "active") || null;
  const targetActiveSession = sessions.find((session) => session.handle === targetOwner &&
    session.board_path === state.BOARD_PATH && session.status === "active") || null;
  const transferState = buildClaimTransferApprovalState({
    ticket: ticketId,
    row: ref.row,
    lock,
    previousOwner,
    targetAgent: target.agent,
    currentThreadId,
    currentThreadSession,
    targetActiveSession,
    force: options.force,
    handoff: options.handoff,
    allowSharedWorktree: options.allowSharedWorktree,
    preservedWorkspace,
    actor: approvalActor({ threadId: currentThreadId, provider: detectRuntimeProvider(),
      runtimeIdentity: identityV2.readEnvIdentity(), threadSession: currentThreadSession }),
  });
  const preview = {
    ticket: ticketId,
    dry_run: true,
    writes: "none",
    status,
    owner: { from: previousOwner, to: targetOwner },
    workspace: {
      lock: lock?.path ? path.relative(COORD_DIR, lock.path) : null,
      lock_recreated: recreateLock,
      worktree: lock?.worktree || preservedWorkspace?.worktree || null,
      branch: lock?.branch || preservedWorkspace?.branch || null,
      ...(preservedWorkspace ? { preserved_workspace: preservedWorkspace } : {}),
      kept: true,
      workspace_owner: { from: workspaceOwnerBefore, to: namespaceOwner },
    },
    approval: { ...approvalRequirement({ verb: "claim --transfer-to", ticket: ticketId, reason: reasonText, row: transferState }), authorized: false },
    provenance: {
      prior_entries: priorProvenance,
      appended: { from: previousOwner, to: targetOwner, workspace_owner: namespaceOwner, reason: reasonText, previous_session_id: previousSessionId },
      journal_event: "claim-ticket",
      journal_details: {
        previous_owner: previousOwner,
        previous_session_id: previousSessionId,
        transfer_to: targetOwner,
        override_reason: reasonText,
        legacy_force_alias: false,
        ...(recreateLock ? { recreated_lock: true } : {}),
        ...(preservedWorkspace ? { preserved_workspace: preservedWorkspace } : {}),
      },
    },
    not_previewed: NOT_PREVIEWED,
  };
  console.log(JSON.stringify(preview, null, 2));
  return preview;
}

module.exports = { previewClaimTransfer };
