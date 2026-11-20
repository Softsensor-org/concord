"use strict";
const { appendSessionBinding, latestSessionBinding } = require("./session-binding-order.js");

// Called only for the resolver's coded missing-session outcome, inside both the
// governance transaction and agent-state lock. Failure never mutates identity.
function adoptRecoverySession(d) {
  const { error, ticketId, expectedOwner, requestedOwner, lock, agents, sessions, threadId, boardPath } = d;
  const refuse = () => { throw error; };
  if (!threadId || requestedOwner !== expectedOwner || !d.completeLock(lock) || lock.ticket !== ticketId ||
      // guard:identity-recovery
      lock.owner !== expectedOwner || lock.status !== "doing" || lock.identity_model === "v2") refuse();
  const owners = agents.filter((a) => a.handle === expectedOwner);
  if (owners.length !== 1 || owners[0].status !== "active" || owners[0].id !== lock.agent_id) refuse();
  const agent = owners[0];
  d.assertProvider(agent);
  const prior = sessions.filter((s) => s.session_id === lock.session_id);
  if (prior.length !== 1 || prior[0].status !== "expired" || prior[0].handle !== expectedOwner ||
      prior[0].agent_id !== agent.id || prior[0].board_path !== boardPath) refuse();
  if (sessions.some((s) => s.board_path === boardPath && s.status === "active" &&
      (s.handle === expectedOwner || s.thread_id === threadId))) refuse();
  if (typeof d.verifyWorkspace !== "function") refuse();
  d.verifyWorkspace();
  const session = replacementSession(d, agent, prior[0]);
  appendSessionBinding(sessions, session);
  d.writeSessions(sessions);
  return { agent, session, autoClaimed: false, autoRegistered: false, recoveredFromSession: prior[0].session_id };
}

function replacementSession(d, agent, prior) {
  const now = new Date().toISOString();
  return { session_id: d.buildSessionId(agent), agent_id: agent.id, handle: agent.handle,
    previous_session_id: prior.session_id, thread_id: d.threadId, board_path: d.boardPath,
    board_root: prior.board_root, host: d.host || prior.host || "unknown-host", cwd: process.cwd(),
    session_label: `continuation:${d.threadId.slice(0, 8)}`, claimed_at: now, last_seen_at: now,
    released_at: null, status: "active", auto_claimed: false };
}

// Only an executing governed mutation may continue an exact native thread.
// Read-only inspection and fallback tokens cannot create a session interval.
function continueReleasedSession(d) {
  if (!d.inMutation || !d.nativeThreadId || d.nativeThreadId !== d.threadId) return null;
  const history = d.sessions.filter((s) => s.board_path === d.boardPath && s.thread_id === d.threadId);
  const prior = latestSessionBinding(history);
  if (!prior) return null;
  if (d.requestedHandle && d.requestedHandle !== prior.handle) return null;
  if (d.sessions.filter((s) => s.session_id === prior.session_id).length !== 1) return null;
  if (prior.release_reason === "explicit") return null;
  const age = Date.now() - Date.parse(prior.last_seen_at || prior.claimed_at || "");
  const terminal = prior.status === "released" && prior.release_reason === "terminal";
  const idle = (prior.status === "expired" || (prior.status === "released" && prior.release_reason === "idle-expiry")) &&
    Number.isFinite(age) && Number.isFinite(d.idleMs) && age >= d.idleMs;
  if (!terminal && !idle) return null;
  const owners = d.agents.filter((a) => a.handle === prior.handle);
  if (owners.length !== 1 || owners[0].status !== "active" || owners[0].id !== prior.agent_id) return null;
  const agent = owners[0];
  d.assertProvider(agent);
  if (d.sessions.some((s) => s.board_path === d.boardPath && s.status === "active" &&
      (s.handle === agent.handle || s.thread_id === d.threadId))) return null;
  const session = replacementSession(d, agent, prior);
  appendSessionBinding(d.sessions, session);
  d.writeSessions(d.sessions);
  return { agent, session, autoClaimed: false, autoRegistered: false, continuedFromSession: prior.session_id };
}
module.exports = { adoptRecoverySession, continueReleasedSession };
