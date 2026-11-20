"use strict";

// Format already-normalized session history without writing or changing authority.
function missingSessionMessage(threadId, sessions, boardPath, compareMostRecent) {
  const history = sessions
    .filter((session) => session.board_path === boardPath && session.thread_id === threadId)
    .sort(compareMostRecent);
  const prior = history[0];
  const bindHint = "Lifecycle/admin operations such as start and update-plan require a claimed binding even when unbound reporting verbs work. Bind a session with `coord/scripts/gov claim --owner <handle|simple-id>` or `coord/scripts/gov agentid --owner <handle|simple-id>`.";
  if (!prior) {
    return `No active claimed agent session for this thread; no prior binding was found. ${bindHint}`;
  }
  const sessionId = prior.session_id || "?";
  const when = prior.released_at || "an unknown time";
  if (prior.status === "released" && prior.release_reason === "explicit") {
    return `No active claimed agent session for this thread; session ${sessionId} was explicitly released at ${when}. ${bindHint}`;
  }
  if (prior.status === "expired" && prior.release_reason === "idle-expiry") {
    return `No active claimed agent session for this thread; session ${sessionId} expired through the idle-session sweep (last seen ${prior.last_seen_at || "unknown"}; recorded ${when}). ${bindHint}`;
  }
  if (prior.status === "expired") {
    const reason = prior.release_reason ? `recorded reason: ${prior.release_reason}` : "release reason unknown";
    return `No active claimed agent session for this thread; session ${sessionId} is expired (${reason}; last seen ${prior.last_seen_at || "unknown"}). ${bindHint}`;
  }
  if (prior.status === "released" && prior.release_reason === "terminal") {
    return `No active claimed agent session for this thread; session ${sessionId} was released after ticket closeout at ${when}. Same-thread governed mutations normally continue this session automatically; otherwise ${bindHint}`;
  }
  return `No active claimed agent session for this thread; most recent binding ${sessionId} is ${prior.status || "inactive"} (last seen ${prior.last_seen_at || "unknown"}). ${bindHint}`;
}

module.exports = { missingSessionMessage };
