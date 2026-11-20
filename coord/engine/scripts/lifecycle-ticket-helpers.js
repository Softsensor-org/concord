"use strict";

module.exports = function createLifecycleTicketHelpers(deps = {}) {
  const {
    STATUS,
  } = deps;

  function buildStartPlanBootstrapCommand(ticketId) {
    return `coord/scripts/gov plan ${ticketId} --seed`;
  }

  function buildPostCloseFollowupCommand(ticketId, row, description = "Follow-up for post-close finding") {
    return `coord/scripts/gov open-followup <NEW-FOLLOWUP-ID> --depends-on ${ticketId} --repo ${row.Repo} --type ${row.Type} --pri ${row.Pri} --description "${description}"`;
  }

  function ticketHasHistoricalCloseoutEvidence(board, ticketId) {
    const prRefs = board?.pr_index?.[ticketId] || [];
    if (Array.isArray(prRefs) && prRefs.length > 0) {
      return true;
    }
    const landingEvidence = board?.landing_index?.[ticketId]?.evidence || [];
    if (Array.isArray(landingEvidence) && landingEvidence.length > 0) {
      return true;
    }
    const findings = board?.review_findings?.[ticketId] || [];
    return Array.isArray(findings) && findings.length > 0;
  }

  function buildHistoricalCloseoutStartBlocker(ticketId, row, board) {
    if ((row.Status !== STATUS.TODO && row.Status !== STATUS.DEFERRED) || !ticketHasHistoricalCloseoutEvidence(board, ticketId)) {
      return null;
    }
    return {
      code: "closed_ticket_history",
      message:
        `Ticket ${ticketId} has historical closeout evidence in pr_index, landing_index, or review_findings and cannot be restarted from "${row.Status}". ` +
        `Closed tickets stay closed; create a follow-up ticket instead of reopening through board edits.`,
      next_steps: [buildPostCloseFollowupCommand(ticketId, row)],
    };
  }

  return {
    buildHistoricalCloseoutStartBlocker,
    buildPostCloseFollowupCommand,
    buildStartPlanBootstrapCommand,
    ticketHasHistoricalCloseoutEvidence,
  };
};
