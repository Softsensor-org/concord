"use strict";

// Writers call these only inside their existing governed agent-state lock.
// Order belongs to one board/native thread, independently of wall-clock time.
function sequenceOf(session) {
  if (!Object.hasOwn(session, "binding_sequence")) return 0;
  const value = session.binding_sequence;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid session binding_sequence; repair ordering metadata before binding.");
  }
  return value;
}

function stampSessionBinding(sessions, session) {
  const history = sessions.filter(s => s.board_path === session.board_path && s.thread_id === session.thread_id);
  const maximum = history.reduce((max, s) => Math.max(max, sequenceOf(s)), 0);
  if (maximum === Number.MAX_SAFE_INTEGER) throw new Error("Session binding_sequence exhausted.");
  session.binding_sequence = maximum + 1;
  return session;
}

function appendSessionBinding(sessions, session) {
  stampSessionBinding(sessions, session);
  sessions.push(session);
  return session;
}

function latestSessionBinding(history) {
  if (!history.length || history.some(s => !Number.isFinite(Date.parse(s.claimed_at)))) return null;
  let orders;
  try { orders = history.map(sequenceOf); } catch { return null; }
  const maximum = orders.reduce((max, value) => Math.max(max, value), 0);
  if (maximum > 0) {
    const latest = history.filter((s, index) => orders[index] === maximum);
    return latest.length === 1 ? latest[0] : null;
  }
  // Legacy writers appended claims, but repair could update an old row. Keep
  // the old unambiguous case; conflicting/tied clocks need explicit binding.
  for (let i = 1; i < history.length; i++) {
    if (Date.parse(history[i].claimed_at) <= Date.parse(history[i - 1].claimed_at)) return null;
  }
  return history.at(-1);
}

module.exports = { stampSessionBinding, appendSessionBinding, latestSessionBinding };
