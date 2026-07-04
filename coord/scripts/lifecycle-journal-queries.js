"use strict";

const QUESTIONS_WORTHY_EVENT_COMMANDS = new Set([
  "recover",
  "repair",
  "manual-reconcile",
  "resume",
]);

module.exports = function createLifecycleJournalQueries(deps = {}) {
  const {
    integerOrDefault,
    readGovernanceEventLog,
    readGovernanceSnapshotArtifact,
  } = deps;

  function summarizeGovernanceEvent(event) {
    if (!event) {
      return null;
    }
    const externalSideEffects = Array.isArray(event.details?.external_side_effects)
      ? event.details.external_side_effects
      : [];
    return {
      ts: event.ts || null,
      command: event.command || null,
      ticket: event.ticket || null,
      result: event.result || "succeeded",
      before_status: event.before_status ?? null,
      after_status: event.after_status ?? null,
      identity: event.identity || null,
      changed_paths: event.changed_paths || [],
      changed_path_count: Array.isArray(event.changed_paths) ? event.changed_paths.length : 0,
      snapshot_digest: event.snapshot_digest || event.snapshot?.digest || null,
      external_side_effects: externalSideEffects,
      details: event.details || null,
    };
  }

  function materializeGovernanceEvent(event) {
    if (!event) {
      return null;
    }
    if (event.snapshot) {
      return event;
    }
    if (!event.snapshot_digest) {
      return event;
    }
    return {
      ...event,
      snapshot: readGovernanceSnapshotArtifact(event.snapshot_digest),
    };
  }

  function uniqueStrings(values = []) {
    return [...new Set((values || []).filter(Boolean).map((value) => String(value)))];
  }

  function collectTicketGovernanceIssueEvents(ticketId, limit = 5) {
    return readGovernanceEventLog()
      .filter((event) => event.ticket === ticketId && QUESTIONS_WORTHY_EVENT_COMMANDS.has(event.command))
      .slice(-limit)
      .reverse()
      .map((event) => ({
        command: event.command,
        ts: event.ts || null,
      }));
  }

  function recentEvents(ticketId, options = {}) {
    const limit = Math.max(1, integerOrDefault(options.limit, 10));
    const full = options.full === true;
    let events = readGovernanceEventLog();
    if (ticketId) {
      events = events.filter((event) => event.ticket === ticketId);
    }
    const visible = events.slice(-limit).reverse().map((event) =>
      full ? materializeGovernanceEvent(event) : summarizeGovernanceEvent(event)
    );
    console.log(JSON.stringify({
      ticket: ticketId || null,
      limit,
      full,
      total_events: events.length,
      events: visible,
    }, null, 2));
  }

  function findLatestTicketGovernanceEvent(ticketId) {
    const events = readGovernanceEventLog().filter((event) => event.ticket === ticketId);
    return events.length > 0 ? events[events.length - 1] : null;
  }

  return {
    collectTicketGovernanceIssueEvents,
    findLatestTicketGovernanceEvent,
    materializeGovernanceEvent,
    recentEvents,
    summarizeGovernanceEvent,
    uniqueStrings,
  };
};
