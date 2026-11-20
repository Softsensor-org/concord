"use strict";

// COORD-635 repair — the landing-record provenance vocabulary, in one place.
//
// The board schema constrains landing_index.provenance_status to this set. The
// audit REPORT's `provenance` bucket is a different namespace: it additionally
// carries "control_plane" for Repo-X rows, which is a reporting classification
// and NOT a legal record value. `applyLandingAuditBackfill` copies report ->
// record, so conflating the two writes a value the validator refuses.
//
// Extracted to its own module so the writer (landing-audit.js) and the parity
// test consume the same constant, and so requiring it cannot pull the whole
// landing-audit factory into a test.
const LANDING_PROVENANCE_STATUSES = Object.freeze(["explicit", "legacy", "fulfilled_by", "unknown"]);

module.exports = { LANDING_PROVENANCE_STATUSES };
