"use strict";

module.exports = function createLifecycleLandingGovernance({
  isRepoBackedCode,
}) {
  function resolveRepoThresholdTicket(threshold, repo) {
    if (!threshold) {
      return null;
    }
    if (typeof threshold === "string") {
      return threshold;
    }
    if (typeof threshold === "object" && repo && typeof threshold[repo] === "string") {
      return threshold[repo];
    }
    return null;
  }

  function parseTicketParts(ticketId) {
    const match = /^([A-Z]+)-(\d+)$/.exec(String(ticketId || ""));
    if (!match) {
      return null;
    }
    return {
      prefix: match[1],
      number: Number.parseInt(match[2], 10),
    };
  }

  function isTicketAtOrAfter(ticketId, thresholdTicketId) {
    const ticketParts = parseTicketParts(ticketId);
    const thresholdParts = parseTicketParts(thresholdTicketId);
    if (!ticketParts || !thresholdParts || ticketParts.prefix !== thresholdParts.prefix) {
      return false;
    }
    return ticketParts.number >= thresholdParts.number;
  }

  function requiresLandingGovernance(board, ticketId, row) {
    if (!row || !isRepoBackedCode(row.Repo)) {
      return false;
    }
    const threshold = resolveRepoThresholdTicket(board?.metadata?.landing_index_required_from_ticket, row.Repo);
    if (!threshold) {
      return false;
    }
    return isTicketAtOrAfter(ticketId, threshold);
  }

  return {
    isTicketAtOrAfter,
    parseTicketParts,
    requiresLandingGovernance,
    resolveRepoThresholdTicket,
  };
};
