"use strict";

// Keep the canonical governance-option setter shared and unchanged. Closeout
// chooses append semantics at the writer boundary; an explicit operator edit
// continues to replace this field through the ordinary setter.
function applyGovernanceOptions(nextRecord, options, { normalizeGovernancePlanShape, resolveRepoCodeForTicket }) {
    if (
      options.closeoutMethod ||
      options.closeoutBaseRef ||
      Object.prototype.hasOwnProperty.call(options, "provenanceNote") ||
      options.reviewProfile
    ) {
      const governance = normalizeGovernancePlanShape(nextRecord.governance, resolveRepoCodeForTicket(nextRecord.ticket_id));
      if (options.closeoutMethod) {
        governance.expected_closeout.method = String(options.closeoutMethod).trim();
      }
      if (options.closeoutBaseRef) {
        governance.expected_closeout.base_ref = String(options.closeoutBaseRef).trim();
      }
      if (Object.prototype.hasOwnProperty.call(options, "provenanceNote")) {
        const note = String(options.provenanceNote || "").trim();
        governance.expected_closeout.provenance_note = note || null;
      }
      if (options.reviewProfile) {
        const reviewProfile = String(options.reviewProfile || "").trim();
        governance.review_profile = reviewProfile === "bounded_repair" ? "bounded_repair" : "standard";
      }
      nextRecord.governance = governance;
    }
}

function withLandingProvenance(record, options) {
  if (!Object.prototype.hasOwnProperty.call(options, "provenanceNote")) return options;
  const existing = String(record.governance?.expected_closeout?.provenance_note || "").trim();
  const landing = String(options.provenanceNote || "").trim();
  const appended = `\n\nLanding provenance:\n${landing}`;
  const note = !landing || existing === landing || existing.endsWith(appended)
    ? existing : existing ? existing + appended : landing;
  return { ...options, provenanceNote: note || null };
}

module.exports = { applyGovernanceOptions, withLandingProvenance };
