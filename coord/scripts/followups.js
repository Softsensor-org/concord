"use strict";

const { STATUS } = require("./governance-constants.js");

const FOLLOWUP_RELATIONS = new Set([
  "blocking",
  "related",
  "closeout-blocker",
  "independent",
]);

// COORD-673: normalize any accepted --depends-on shape into an ORDERED, deduped
// id list. Accepts a bare id, the comma-separated form ("A,B" — previously
// unparsed and rejected as a single nonexistent id), an array (the repeated
// --depends-on flag form — previously last-wins), or nested combinations. Splits
// on the same delimiter governance-validation.js#splitDependsOn uses to feed
// readiness, so what this writer records is exactly what readiness reads back.
//
// Deliberately module-level and dependency-free (not a factory member and not
// wired through the lifecycle.js composition root, per the COORD-396/397
// un-growable-root policy): lifecycle-ticket-admin.js requires it directly.
function parseDependsOnList(value) {
  const flat = [];
  const visit = (item) => {
    if (item === null || item === undefined) return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    for (const part of String(item).split(",").map((part) => part.trim()).filter(Boolean)) {
      flat.push(part);
    }
  };
  visit(value);
  const seen = new Set();
  const ordered = [];
  for (const id of flat) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

function createFollowups(deps = {}) {
  const {
    fail,
    getRows,
    readBoard,
    uniqueStrings,
    isDoingStatus,
    // COORD-279 (item 3): OPTIONAL deferred accessor for the journal's historical
    // ticket-id set. When wired, nextTicketId reserves against the MAX of live
    // board rows AND every id that ever existed in the journal, so a removed
    // row's id is never reissued (historical-collision class). Optional so the
    // pure followups surface stays unit-testable without a journal.
    historicalTicketIds,
  } = deps;

function buildDependencyRepairNextSteps(ticketId, readiness, board) {
  if (readiness.cycles.length > 0) {
    return uniqueStrings([
      ...readiness.blockedBy.map((depId) => `coord/scripts/gov explain ${depId}`),
      `coord/scripts/gov explain ${ticketId}`,
    ]);
  }
  const nextSteps = readiness.blockedBy.map((depId) => `coord/scripts/gov explain ${depId}`);
  if (readiness.deps.length !== 1 || readiness.blockedBy.length !== 1) {
    return nextSteps;
  }

  const depId = readiness.blockedBy[0];
  const exception = board?.followup_exceptions?.[ticketId];
  const currentType = exception?.parent === depId ? exception.type : null;
  if (currentType !== "related-followup") {
    nextSteps.push(`coord/scripts/gov set-followup-relation ${ticketId} --depends-on ${depId} --relation related`);
  }
  if (currentType !== "closeout-blocker") {
    nextSteps.push(`coord/scripts/gov set-followup-relation ${ticketId} --depends-on ${depId} --relation closeout-blocker`);
  }
  return nextSteps;
}

function normalizeFollowupRelation(options = {}, fallback = "blocking") {
  const relation = String(
    options.relation || (options.closeoutBlocker ? "closeout-blocker" : fallback)
  ).trim().toLowerCase();
  if (!FOLLOWUP_RELATIONS.has(relation)) {
    fail(
      `Invalid follow-up relation "${relation}". ` +
      "Use blocking, related, closeout-blocker, or independent."
    );
  }
  if (options.closeoutBlocker && relation !== "closeout-blocker") {
    fail('Do not combine --closeout-blocker with --relation values other than "closeout-blocker".');
  }
  return relation;
}

function followupRelationToExceptionType(relation) {
  if (relation === "related") {
    return "related-followup";
  }
  if (relation === "closeout-blocker") {
    return "closeout-blocker";
  }
  return null;
}

// COORD-673: returns the ticket's new "Depends On" value and updates
// board.followup_exceptions.
//
// BOARD CONTRACT (established for this ticket, not invented by it): "Depends On"
// is a COMMA-SEPARATED LIST — governance-validation.js#splitDependsOn feeds
// evaluateReadiness, which iterates every entry and reports each unmet one in
// readiness.blockedBy. Multiple dependency edges per ticket are therefore
// contract-legal, and only this writer was single-valued: it overwrote the field
// with the newest parent, silently deleting governed edges that readiness (the
// board's own don't-pick-this-up safety property) computes over.
// followup_exceptions[<ticket>] is by contrast a SINGLE {parent, type} record,
// so the relations that need one bind exactly one parent — and where honoring the
// request would DISCARD recorded state, this writer now FAILS CLOSED instead.
//
// options:
//   existingDependsOn — the row's current "Depends On" value (edges accumulate onto it)
//   dependsOnList     — parsed --depends-on values (string | string[] | comma form)
//   replace           — explicit opt-in to REPLACE the recorded edge set / exception
function applyFollowupRelation(board, ticketId, parentTicketId, relation, options = {}) {
  if (!board.followup_exceptions || typeof board.followup_exceptions !== "object" || Array.isArray(board.followup_exceptions)) {
    board.followup_exceptions = {};
  }
  const replace = Boolean(options.replace);
  const requested = parseDependsOnList(
    options.dependsOnList === undefined ? parentTicketId : options.dependsOnList
  );
  const existing = parseDependsOnList(options.existingDependsOn);
  const currentException = board.followup_exceptions[ticketId] || null;
  const describeException = () => (
    `${currentException.parent} (recorded as ${currentException.type})`
  );

  if (relation === "independent") {
    // No --depends-on: the operator asked to clear the ticket's dependency
    // metadata wholesale. With --depends-on: remove ONLY the named edges, so
    // detaching one blocker never discards the others.
    if (requested.length === 0) {
      delete board.followup_exceptions[ticketId];
      return existing.join(", ");
    }
    const removed = new Set(requested);
    if (currentException && removed.has(currentException.parent)) {
      delete board.followup_exceptions[ticketId];
    }
    return existing.filter((id) => !removed.has(id)).join(", ");
  }

  if (requested.length === 0) {
    fail(`Follow-up relation "${relation}" requires --depends-on <ticket-id>.`);
  }

  const exceptionType = followupRelationToExceptionType(relation);
  if (exceptionType) {
    if (requested.length > 1) {
      fail(
        `Follow-up relation "${relation}" records exactly one parent: the board stores a single ` +
        `{parent, type} follow-up exception per ticket, so ${requested.length} parents ` +
        `(${requested.join(", ")}) cannot all be recorded as "${relation}". ` +
        `Record one as "${relation}" and add the rest with --relation blocking.`
      );
    }
    const parent = requested[0];
    if (currentException && currentException.parent !== parent && !replace) {
      fail(
        `Refusing to discard the follow-up exception already recorded for ${ticketId}: ` +
        `${describeException()}. Pass --replace to replace it deliberately, or clear it first with ` +
        `\`set-followup-relation ${ticketId} --depends-on ${currentException.parent} --relation independent\`.`
      );
    }
    board.followup_exceptions[ticketId] = { parent, type: exceptionType };
  } else {
    // relation "blocking" carries no exception record. Dropping an exception that
    // belongs to a DIFFERENT parent would silently promote that parent's
    // related/closeout-only edge to a hard blocker, so refuse unless replacing.
    if (currentException && !requested.includes(currentException.parent) && !replace) {
      fail(
        `Refusing to discard the follow-up exception already recorded for ${ticketId}: ` +
        `${describeException()}. Pass --replace to replace it deliberately, or clear it first with ` +
        `\`set-followup-relation ${ticketId} --depends-on ${currentException.parent} --relation independent\`.`
      );
    }
    delete board.followup_exceptions[ticketId];
  }

  const next = replace ? requested : parseDependsOnList([existing, requested]);
  return next.join(", ");
}

function nextTicketId(board, prefix) {
  const P = String(prefix || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!P) fail('Auto-id needs a letters-only --prefix, e.g. --prefix TRUST.');
  let max = 0, width = 3;
  const consider = (id) => {
    const m = String(id || "").match(/^([A-Z]+)-(\d+)$/);
    if (m && m[1] === P) {
      const n = parseInt(m[2], 10);
      if (n > max) max = n;
      if (m[2].length > width) width = m[2].length;
    }
  };
  for (const row of getRows(board)) {
    consider(row.ID);
  }
  // COORD-279 (item 3): also reserve against the journal's historical ids so a
  // removed row's id is never reissued (collides with immutable history).
  if (typeof historicalTicketIds === "function") {
    let historical;
    try {
      historical = historicalTicketIds() || [];
    } catch (error) {
      // COORD-430: fail CLOSED. The prior catch silently fell back to live-rows-
      // only, re-enabling the exact historical-id reuse COORD-279 prevents (a
      // removed row's id reissued, colliding with immutable audit lineage) with no
      // signal. Surface the failure so the enclosing governed mutation aborts and
      // can retry once the journal is readable, rather than allocating a possibly-
      // colliding id. (An empty/new journal returns [] and does not throw.)
      throw new Error(
        `nextTicketId: cannot reserve ids against journal history (journal read failed: ${error?.message || error}). ` +
        `Refusing to allocate an id that may collide with immutable history — repair the journal (gov doctor / gov recover) and retry.`
      );
    }
    for (const id of historical) {
      consider(id);
    }
  }
  return `${P}-${String(max + 1).padStart(width, "0")}`;
}

function printNextId(prefix) { console.log(nextTicketId(readBoard(), prefix)); }

function resolveFollowupPromptPath({ board, parentTicketId, explicitPrompt }) {
  const promptPath = explicitPrompt || board.prompt_index?.[parentTicketId] || null;
  if (!promptPath) {
    fail(`open-followup requires prompt coverage: pass --prompt <path> or ensure parent ticket ${parentTicketId} has prompt_index coverage.`);
  }
  return promptPath;
}

function allowsFollowupDependencyReadinessException({ board, row, depId, dep }) {
  if (!board || !row || !dep) {
    return false;
  }
  const exception = board.followup_exceptions?.[row.ID];
  if (!exception || exception.parent !== depId) {
    return false;
  }
  if (exception.type === "related-followup") {
    return true;
  }
  if (exception.type === "closeout-blocker") {
    return isDoingStatus(dep.Status) || dep.Status === STATUS.REVIEW;
  }
  return false;
}

function findOutstandingCloseoutBlockerFollowups(board, parentTicketId) {
  return getRows(board).filter((row) => {
    const exception = board.followup_exceptions?.[row.ID];
    if (!exception || exception.type !== "closeout-blocker" || exception.parent !== parentTicketId) {
      return false;
    }
    // COORD-285: a `proposed` (quarantined) follow-up has not been accepted as
    // real work yet, so it must not count as an OUTSTANDING closeout blocker for
    // its parent — only non-terminal, non-quarantined work blocks closeout.
    return (
      row.Status !== STATUS.DONE &&
      row.Status !== STATUS.SUPERSEDED &&
      row.Status !== STATUS.PROPOSED
    );
  });
}

  return {
    buildDependencyRepairNextSteps,
    normalizeFollowupRelation,
    followupRelationToExceptionType,
    applyFollowupRelation,
    parseDependsOnList,
    nextTicketId,
    printNextId,
    resolveFollowupPromptPath,
    allowsFollowupDependencyReadinessException,
    findOutstandingCloseoutBlockerFollowups,
  };
}

module.exports = createFollowups;
// COORD-673: pure helper exposed alongside the factory so consumers can use it
// without a factory instance (and without new composition-root wiring).
module.exports.parseDependsOnList = parseDependsOnList;
