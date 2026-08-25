"use strict";

// B1 decomposition slice: pure, dependency-free helpers extracted from
// lifecycle.js. These functions close over no module state and are safe to
// import directly. Keep this module free of governance/state coupling so it
// stays trivially testable and reusable across the engine.

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "work";
}

function integerOrDefault(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

// The round a ticket ADVANCES INTO when a reviewer returns it to doing. This is
// the only round-advancing step in the lifecycle: `return-doing` writes this
// number onto BOTH the new finding and the plan record's `review_round`, so the
// pair stays consistent by construction.
function inferNextRound(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return 1;
  }
  return Math.max(...findings.map((finding) => finding.round || 1)) + 1;
}

// COORD-649: the round a ticket is CURRENTLY IN — what a finding recorded right
// now belongs to. `inferNextRound` was previously used for both questions, so
// recording N findings from ONE review auto-incremented them to rounds 1..N.
// Because the review-readiness check requires the plan's `review_round` to equal
// max(finding rounds), and the ONLY writer of `review_round` is the
// `return-doing` transition (which requires status=review — precisely what the
// check blocks), that produced an unsatisfiable closed loop.
//
// The plan record is AUTHORITATIVE when it carries a usable round: it is written
// only by the governed round-advancing transition, so it states how many repair
// rounds actually happened. Findings are a fallback for tickets with no plan
// record yet, and deliberately use max() (not max()+1) — an existing finding is
// evidence of the round the ticket is in, not of a round it has moved past.
function currentReviewRound(planRecord, findings) {
  const planRound = integerOrDefault(planRecord && planRecord.review_round, null);
  if (Number.isInteger(planRound) && planRound >= 1) {
    return planRound;
  }
  if (!Array.isArray(findings) || findings.length === 0) {
    return 1;
  }
  const observed = Math.max(
    ...findings.map((finding) => {
      const round = integerOrDefault(finding && finding.round, 1);
      return Number.isInteger(round) && round >= 1 ? round : 1;
    })
  );
  return Number.isInteger(observed) && observed >= 1 ? observed : 1;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function escapeTable(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  slugify,
  integerOrDefault,
  inferNextRound,
  currentReviewRound,
  todayIso,
  escapeTable,
  escapeRegex,
  shellEscape,
};
