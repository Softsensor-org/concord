"use strict";

// COORD-737: repo -> board reconciliation is deliberately a report, not a
// closeout mechanism.  A merged PR proves only that remote work exists; it
// never grants this command authority to change board status or ownership.

const TICKET_ID_RE = /\b[A-Z][A-Z0-9_]*-\d+\b/g;

function candidateTicketIds(pr) {
  const text = [pr?.title, pr?.body, pr?.headRefName].filter(Boolean).join(" ");
  return [...new Set(text.match(TICKET_ID_RE) || [])];
}

function reconcileLandingCandidates({ rows = [], landingIndex = {}, pullRequests = [],
  isCommitAncestorOfRef = () => null, repoRoot = null, baseRef = null } = {}) {
  const rowsById = new Map(rows.map((row) => [String(row.ID), row]));
  return pullRequests
    .filter((pr) => String(pr?.state || "").toUpperCase() === "MERGED" && pr?.mergedAt)
    .map((pr) => {
      const ids = candidateTicketIds(pr);
      const ticketId = ids.length === 1 ? ids[0] : null;
      const row = ticketId ? rowsById.get(ticketId) : null;
      const landing = ticketId ? landingIndex[ticketId] || null : null;
      const mergeCommit = pr.mergeCommit?.oid || pr.mergeCommit || pr.merge_commit_sha || null;
      const ancestry = mergeCommit && repoRoot && baseRef
        ? isCommitAncestorOfRef(repoRoot, mergeCommit, baseRef)
        : null;
      let classification = "unrelated";
      if (ids.length > 1) classification = "ambiguous";
      else if (ids.length === 1 && !row) classification = "untracked";
      else if (ids.length === 1 && landing) classification = "recorded";
      else if (ids.length === 1) classification = "merged_without_closeout";
      return {
        classification,
        ticket_id: ticketId,
        candidate_ticket_ids: ids,
        pr_url: pr.url || null,
        title: pr.title || null,
        head: pr.headRefName || null,
        merge_commit: mergeCommit,
        merged_at: pr.mergedAt,
        ancestry,
        ancestry_status: ancestry === true ? "confirmed" : ancestry === false ? "not_ancestor" : "unknown",
      };
    });
}

function summarizeLandingReconciliation(entries = []) {
  return entries.reduce((summary, entry) => {
    summary[entry.classification] = (summary[entry.classification] || 0) + 1;
    return summary;
  }, { recorded: 0, merged_without_closeout: 0, untracked: 0, ambiguous: 0, unrelated: 0 });
}

module.exports = { candidateTicketIds, reconcileLandingCandidates, summarizeLandingReconciliation };
