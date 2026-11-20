"use strict";

const approvalVerifier = require("./approval-verifier.js");
const { assertReviewWorkspaceTransferable } = require("./review-workspace-evidence.js");

// The preview and mutation use one projection for a ticket transfer approval.
// Session heartbeats are intentionally omitted; ownership and workspace identity
// remain bound while harmless last-seen refreshes do not invalidate a review.
function sessionIdentity(session) {
  if (!session) return null;
  return {
    session_id: session.session_id || null,
    agent_id: session.agent_id || null,
    handle: session.handle || null,
    board_path: session.board_path || null,
    thread_id: session.thread_id || null,
    status: session.status || null,
  };
}

function lockIdentity(lock) {
  if (!lock) return null;
  return {
    path: lock.path || null,
    ticket: lock.ticket || null,
    owner: lock.owner || null,
    agent_id: lock.agent_id || null,
    session_id: lock.session_id || null,
    status: lock.status || null,
    repo: lock.repo || null,
    branch: lock.branch || null,
    head: lock.head || null,
    worktree: lock.worktree || null,
    workspace_owner: lock.workspace_owner || null,
    transfer_provenance: Array.isArray(lock.transfer_provenance) ? lock.transfer_provenance : [],
  };
}

function approvalActor({ threadId, provider, runtimeIdentity, threadSession }) {
  return {
    thread_id: threadId || null,
    provider: provider || null,
    owner_lease_instance_id: runtimeIdentity?.present ? runtimeIdentity.instanceId || null : null,
    current_session: sessionIdentity(threadSession),
  };
}

function buildClaimTransferApprovalState({
  ticket,
  row,
  lock,
  previousOwner,
  targetAgent,
  currentThreadId,
  currentThreadSession,
  targetActiveSession,
  force,
  handoff,
  allowSharedWorktree,
  preservedWorkspace,
  actor,
}) {
  return {
    ticket,
    row,
    previous_owner: previousOwner,
    transfer_to: targetAgent.handle,
    target_agent: {
      id: targetAgent.id,
      handle: targetAgent.handle,
      provider: targetAgent.provider || null,
      status: targetAgent.status,
    },
    current_thread_id: currentThreadId || null,
    actor: actor || null,
    current_thread_session: sessionIdentity(currentThreadSession),
    target_active_session: sessionIdentity(targetActiveSession),
    lock: lockIdentity(lock),
    force: Boolean(force),
    handoff: Boolean(handoff),
    allow_shared_worktree: allowSharedWorktree === true,
    preserved_workspace: preservedWorkspace || null,
  };
}

function buildLiveSessionTakeoverState({ targetAgent, currentThreadId, currentThreadSession, targetActiveSession,
  force, handoff, actor }) {
  return {
    target_agent: {
      id: targetAgent.id,
      handle: targetAgent.handle,
      provider: targetAgent.provider || null,
      status: targetAgent.status,
    },
    current_thread_id: currentThreadId || null,
    actor: actor || null,
    current_thread_session: sessionIdentity(currentThreadSession),
    target_active_session: sessionIdentity(targetActiveSession),
    force: Boolean(force),
    handoff: Boolean(handoff),
  };
}

// Authority is scoped to one command factory. Callers can pass an object that
// resembles a capability, but only this closure can mark an approved transfer.
function createClaimApprovalAuthority(deps, resolveHumanAdminOverride) {
  const { state, identityV2, readAgentSessions, currentRuntimeThreadId, detectRuntimeProvider,
    readBoard, getTicketRef, findLockForTicket, resolveAgentIdentifier, readAgentsRegistry,
    fail } = deps;
  const TRANSFER_REBIND_AUTHORIZATION = Symbol("verified-claim-transfer-rebind");
  const runtimeIdentitySnapshot = () => typeof identityV2.readEnvIdentity === "function"
    ? identityV2.readEnvIdentity() : { present: false };

  function transferApprovalContext(ticketId, row, lock, previousOwner, targetAgent, options, preservedWorkspace) {
    const sessions = readAgentSessions({ readOnly: true });
    const currentThreadId = currentRuntimeThreadId();
    const currentThreadSession = sessions.find((session) => session.thread_id === currentThreadId &&
      session.board_path === state.BOARD_PATH && session.status === "active") || null;
    const targetActiveSession = sessions.find((session) => session.handle === targetAgent.handle &&
      session.board_path === state.BOARD_PATH && session.status === "active") || null;
    const actor = approvalActor({ threadId: currentThreadId, provider: detectRuntimeProvider(),
      runtimeIdentity: runtimeIdentitySnapshot(), threadSession: currentThreadSession });
    return {
      approvalState: buildClaimTransferApprovalState({ ticket: ticketId, row, lock, previousOwner, targetAgent,
        currentThreadId, currentThreadSession, targetActiveSession, force: options.force, handoff: options.handoff,
        allowSharedWorktree: options.allowSharedWorktree, preservedWorkspace, actor }),
      rebindState: buildLiveSessionTakeoverState({ targetAgent, currentThreadId, currentThreadSession,
        targetActiveSession, force: options.force, handoff: options.handoff, actor }),
      targetAgent,
    };
  }

  function authorizeClaim({ isOwnerTransfer, ticketId, row, lock, previousOwner, targetOwner, targetAgent, options, preservedWorkspace }) {
    const transferContext = isOwnerTransfer
      ? transferApprovalContext(ticketId, row, lock, previousOwner, targetAgent, options, preservedWorkspace)
      : null;
    const transferApprovalStateJson = transferContext
      ? approvalVerifier.canonicalJson(transferContext.approvalState) : null;
    const transferRebindStateJson = transferContext
      ? approvalVerifier.canonicalJson(transferContext.rebindState) : null;
    // ADR 0031: after the read-only refusals, before any write (a refused transfer journals no approval).
    const override = isOwnerTransfer
      ? approvalVerifier.requireSignedOverride({ commandName: "claim --transfer-to", ticketId, row: transferContext.approvalState, options, deps: { ...deps, runtimeDir: deps.state.RUNTIME_DIR, resolveHumanAdminOverride } })
      : options.humanAdminOverride !== undefined
        ? approvalVerifier.requireSignedOverride({ commandName: "claim --human-admin-override", ticketId,
          row: { ticket: row, lock: lock || null, previous_owner: previousOwner,
            transfer_to: targetOwner, force: options.force === true,
            allowSharedWorktree: options.allowSharedWorktree === true },
          options, deps: { ...deps, runtimeDir: deps.state.RUNTIME_DIR, resolveHumanAdminOverride } })
        : null;
    let transferAuthorization = null;
    if (isOwnerTransfer) {
      transferAuthorization = {
        [TRANSFER_REBIND_AUTHORIZATION]: true,
        approval: override.approval,
        approvalStateJson: transferApprovalStateJson,
        rebindStateJson: transferRebindStateJson,
        validate: () => {
          const currentBoard = readBoard();
          const currentRef = getTicketRef(currentBoard, ticketId);
          if (!currentRef) fail(`Unknown ticket "${ticketId}".`);
          const currentLock = findLockForTicket(ticketId);
          const currentPreservedWorkspace = assertReviewWorkspaceTransferable({ isOwnerTransfer: true, ticketId,
            row: currentRef.row, currentOwner: previousOwner, prRefs: currentBoard.pr_index?.[ticketId], fail });
          const currentTarget = resolveAgentIdentifier(targetOwner, readAgentsRegistry());
          if (!currentTarget || currentTarget.agent.status !== "active") fail(`Unknown or inactive transfer target "${targetOwner}".`);
          const currentContext = transferApprovalContext(ticketId, currentRef.row, currentLock, previousOwner,
            currentTarget.agent, options, currentPreservedWorkspace);
          if (approvalVerifier.canonicalJson(currentContext.approvalState) !== transferApprovalStateJson) {
            fail("claim --transfer-to: ticket, target session or workspace changed after human approval; review and retry.");
          }
          return currentContext;
        },
      };
    }
    return { override, transferAuthorization };
  }

  function sessionState({ existingThreadSession, sessions, targetAgent, currentThreadId, provider }) {
    const currentThreadSession = existingThreadSession ? { ...existingThreadSession } : null;
    const existingTarget = sessions.find((session) => session.handle === targetAgent.handle &&
      session.board_path === state.BOARD_PATH && session.status === "active") || null;
    const targetActiveSession = existingTarget ? { ...existingTarget } : null;
    const actor = approvalActor({ threadId: currentThreadId, provider,
      runtimeIdentity: runtimeIdentitySnapshot(), threadSession: currentThreadSession });
    return { currentThreadSession, targetActiveSession, actor };
  }

  function validateTransfer(candidate, currentSessionState) {
    const transferAuthorization = candidate?.[TRANSFER_REBIND_AUTHORIZATION] === true ? candidate : null;
    if (transferAuthorization) {
      if (!transferAuthorization.approval?.record_id || typeof transferAuthorization.validate !== "function") {
        fail("claim --transfer-to: verified approval binding is incomplete; retry the transfer.");
      }
      const currentRebindState = buildLiveSessionTakeoverState(currentSessionState);
      if (approvalVerifier.canonicalJson(currentRebindState) !== transferAuthorization.rebindStateJson) {
        fail("claim --transfer-to: target agent, session or invoking thread changed after human approval; review and retry.");
      }
      transferAuthorization.validate();
    }
    return transferAuthorization;
  }

  function authorizeTakeover({ existingActive, live, overrideReason, flag, resolved, currentThreadId, options, sessionState, transferAuthorization }) {
    const takeoverState = buildLiveSessionTakeoverState({ targetAgent: resolved.agent, currentThreadId,
      ...sessionState,
      force: options.force, handoff: options.handoff });
    let takeoverApproval = null;
    if (existingActive && live && !overrideReason) {
      fail(
        `Refusing a forced rebind of ${resolved.agent.handle} (${resolved.agent.id}): it is bound to live session ` +
        `${existingActive.session_id} on another thread (${existingActive.thread_id}). ${flag} does not authorize ` +
        "taking a handle from another session. Return to that session; if it is a stray that holds no work, release it with " +
        `\`coord/scripts/gov agent-release ${existingActive.session_id} --human-admin-override "<reason>"\`. A human-authorized takeover passes ` +
        '--human-admin-override "<reason>".'
      );
    }
    if (existingActive && live && !transferAuthorization) {
      takeoverApproval = approvalVerifier.requireSignedOverride({
        commandName: "agent claim --human-admin-override",
        ticketId: resolved.agent.handle,
        row: takeoverState,
        options,
        deps: { ...deps, runtimeDir: deps.state.RUNTIME_DIR, resolveHumanAdminOverride },
      }).approval;
    }
    return takeoverApproval;
  }
  return { authorizeClaim, sessionState, validateTransfer, authorizeTakeover };
}

module.exports = { createClaimApprovalAuthority, approvalActor, buildClaimTransferApprovalState, buildLiveSessionTakeoverState, sessionIdentity };
