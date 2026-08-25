"use strict";

// COORD-594: agent-session reaping/release helpers, extracted from the
// lifecycle composition root under the no-grandfather prodloc policy (the root
// grew past its high-water LOC budget and the policy prefers extraction over a
// budget bump).
//
// This is a cohesive cluster: every function here decides WHEN an agent session
// stops being active (idle auto-claimed provider stubs, a terminal ticket's
// owner session) or ORDERS sessions by recency. It owns no state of its own —
// board/registry/session IO, the agent-state lock, and the ticket lookups are
// all injected. Collaborators that are constructed LATER in the root (the
// governance-session factory supplies listIdleActiveAgentSessions /
// readAgentSessions / readAgentsRegistry / withAgentStateLock /
// resolveEffectiveThreadId / normalizeOwnerValue / findDoingTicketForOwner)
// are injected as deferred `(...a) => fn(...a)` wrappers that resolve at call
// time, so factory ordering in the root is irrelevant. `state` is injected BY
// REFERENCE because the testing facade rebinds its paths at runtime.
//
// Behavior is byte-for-byte the same as the in-root versions; the three names
// are re-destructured back into lifecycle scope so the governance-session
// factory, the doctor/queue factories, the `commands` dispatch table and the
// `__testing` facade resolve exactly as before.
module.exports = function createLifecycleSessionReaping({
  STATUS,
  findDoingTicketForOwner,
  getTicketRef,
  listIdleActiveAgentSessions,
  normalizeOwnerValue,
  readAgentSessions,
  readAgentsRegistry,
  readBoard,
  resolveEffectiveThreadId,
  state,
  withAgentStateLock,
  writeJsonFile,
}) {
  function reapIdleAutoClaimedProviderStubs(options = {}) {
    const provider = options.provider || null;
    const board = options.board || readBoard();
    const agents = Array.isArray(options.agents) ? options.agents : readAgentsRegistry();
    const sessions = Array.isArray(options.sessions) ? options.sessions : readAgentSessions();
    const protectedThread = options.protectedThread || null;
    const includeManualStaleAfterMs = Number.isFinite(options.includeManualStaleAfterMs)
      ? options.includeManualStaleAfterMs
      : null;
    const idle = listIdleActiveAgentSessions(board, { agents, sessions });
    const released = [];
    const now = new Date().toISOString();
    const nowMs = Date.now();
    for (const { agent, session } of idle) {
      if (provider && agent.provider !== provider) {
        continue;
      }
      if (!session.auto_claimed) {
        if (includeManualStaleAfterMs === null) {
          continue;
        }
        const lastSeenMs = Date.parse(session.last_seen_at || session.claimed_at || 0);
        if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs < includeManualStaleAfterMs) {
          continue;
        }
      }
      if (protectedThread && session.thread_id === protectedThread) {
        continue;
      }
      session.status = "released";
      session.released_at = now;
      session.last_seen_at = now;
      released.push({ session_id: session.session_id, handle: session.handle, agent_id: agent.id });
    }
    if (released.length > 0 && options.persist !== false) {
      writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
    }
    return { released, sessions };
  }

  function releaseTerminalTicketSession(ticketId, options = {}) {
    if (
      options.terminalSync &&
      options.terminalSync.session_release_safe !== true
    ) {
      return {
        released: [],
        reason: "canonical-publication-unverified",
        publication: options.terminalSync.publication || null,
      };
    }
    const board = options.board || readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref || ![STATUS.DONE, STATUS.SUPERSEDED].includes(ref.row.Status)) {
      return { released: [], reason: "ticket-not-terminal" };
    }
    const owner = normalizeOwnerValue(ref.row.Owner);
    if (!owner) {
      return { released: [], reason: "no-owner" };
    }
    if (findDoingTicketForOwner(board, owner)) {
      return { released: [], reason: "owner-has-doing-ticket" };
    }
    const effectiveThread = Object.prototype.hasOwnProperty.call(options, "effectiveThread")
      ? options.effectiveThread
      : resolveEffectiveThreadId();
    if (!effectiveThread) {
      return { released: [], reason: "no-current-thread" };
    }

    return withAgentStateLock(() => {
      const sessions = readAgentSessions();
      const now = new Date().toISOString();
      const released = [];
      for (const session of sessions) {
        if (
          session.status === "active" &&
          session.board_path === state.BOARD_PATH &&
          session.handle === owner &&
          session.thread_id === effectiveThread
        ) {
          session.status = "released";
          session.released_at = now;
          session.last_seen_at = now;
          released.push({
            session_id: session.session_id,
            handle: session.handle,
            agent_id: session.agent_id || null,
            ticket: ticketId,
          });
        }
      }
      if (released.length > 0 && options.persist !== false) {
        writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
      }
      return { released, sessions, reason: released.length > 0 ? "released-terminal-ticket-session" : "no-matching-session" };
    });
  }

  function compareSessionsMostRecentFirst(left, right) {
    const leftTs = Date.parse(left.last_seen_at || left.claimed_at || 0);
    const rightTs = Date.parse(right.last_seen_at || right.claimed_at || 0);
    if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && rightTs !== leftTs) {
      return rightTs - leftTs;
    }
    return String(right.claimed_at || "").localeCompare(String(left.claimed_at || ""));
  }

  return {
    compareSessionsMostRecentFirst,
    reapIdleAutoClaimedProviderStubs,
    releaseTerminalTicketSession,
  };
};
