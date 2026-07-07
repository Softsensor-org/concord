"use strict";

const { STATUS } = require("./governance-constants.js");

const FOLLOWUP_RELATIONS = new Set([
  "blocking",
  "related",
  "closeout-blocker",
  "independent",
]);

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

function applyFollowupRelation(board, ticketId, parentTicketId, relation) {
  if (!board.followup_exceptions || typeof board.followup_exceptions !== "object" || Array.isArray(board.followup_exceptions)) {
    board.followup_exceptions = {};
  }
  if (relation === "independent") {
    delete board.followup_exceptions[ticketId];
    return "";
  }
  if (!parentTicketId) {
    fail(`Follow-up relation "${relation}" requires --depends-on <ticket-id>.`);
  }
  const exceptionType = followupRelationToExceptionType(relation);
  if (exceptionType) {
    board.followup_exceptions[ticketId] = {
      parent: parentTicketId,
      type: exceptionType,
    };
  } else {
    delete board.followup_exceptions[ticketId];
  }
  return parentTicketId;
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
    nextTicketId,
    printNextId,
    resolveFollowupPromptPath,
    allowsFollowupDependencyReadinessException,
    findOutstandingCloseoutBlockerFollowups,
  };
}

module.exports = createFollowups;
