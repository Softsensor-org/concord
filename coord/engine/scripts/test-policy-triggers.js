"use strict";

// COORD-974 (ADR 0025 decision 2): the full-suite triggers that `gov test-policy
// resolve` reports. Four triggers are measured here (COORD-1031 adds core):
//   counter   at least `landed_tickets` tickets have landed on dev since the last
//             passing full run (landing_index recorded_at after last-qualified.at;
//             with no recorded full run every landing counts);
//   radius    the affected suites exceed `radius_percent` of the suite total
//             (integer arithmetic: selected * 100 > percent * total);
//   core      the selector reports a core_surface fallback (ADR 0025 decision 2(b));
//   unknown   the selector falls back for unknown impact (an unknown dependency,
//             unknown dependents, incomplete analysis, an unattributed generated
//             file). T2 surfaces and always-enforced guards are reported by the
//             selector itself, not here.
// The triggers are REPORTED only. ADR 0025 acceptance does not switch the PR gate;
// the plan decision is unchanged until that is a separate governed change.

const UNKNOWN_FALLBACK_CODES = Object.freeze(["dynamic_dependency", "unknown_dependents", "incomplete_analysis", "unattributed_generated"]);
// COORD-1031 (ADR 0025 decision 2(b)): a change to the test runner, the selector, the policy, shared
// fixtures, the journal or the integration-authority core runs the full suite. The selector reports
// those paths with the core_surface reason (test-policy.json fallback_paths).
const CORE_SURFACE_CODES = Object.freeze(["core_surface"]);

const ms = (iso) => Date.parse(iso);

// The landings that count toward the next full run, and how many there are.
function counterState({ landings = [], lastQualified = null, threshold }) {
  const baseline = lastQualified && lastQualified.at ? lastQualified.at : null;
  const since = baseline ? landings.filter((l) => ms(l.recorded_at) > ms(baseline)) : landings;
  const landed = since.length;
  const fired = landed >= threshold;
  const where = baseline ? `since the last full run at ${baseline}` : "(no passing full run recorded)";
  const reason = fired
    ? `${landed} tickets landed on dev ${where}; the threshold of ${threshold} is reached, so the full suite is due`
    : `${landed} of ${threshold} tickets landed on dev ${where}`;
  return { baseline_at: baseline, landed_since: landed, threshold, fired, reason };
}

function radiusState({ selected, total, percent }) {
  const measurable = Number.isInteger(selected) && Number.isInteger(total) && total > 0;
  if (!measurable) return { selected: selected ?? null, total: total ?? null, share_percent: null, threshold_percent: percent, measurable: false, fired: false, reason: "the affected-suite share is not measurable" };
  const share = Math.round((selected / total) * 1000) / 10;
  const fired = selected * 100 > percent * total;
  const reason = fired
    ? `${selected} of ${total} suites (${share}%) are affected, above the ${percent}% radius threshold`
    : `${selected} of ${total} suites (${share}%) are affected, within the ${percent}% radius threshold`;
  return { selected, total, share_percent: share, threshold_percent: percent, measurable: true, fired, reason };
}

function coreSurfaceState({ fallbackCodes = [] }) {
  const codes = [...new Set(fallbackCodes.filter((c) => CORE_SURFACE_CODES.includes(c)))].sort();
  const fired = codes.length > 0;
  return { codes, fired, reason: fired ? `the change touches the core surface (${codes.join(", ")}); the full suite runs` : "the change does not touch the core surface" };
}

function unknownState({ fallbackCodes = [] }) {
  const codes = [...new Set(fallbackCodes.filter((c) => UNKNOWN_FALLBACK_CODES.includes(c)))].sort();
  const fired = codes.length > 0;
  return { codes, fired, reason: fired ? `the selector cannot establish the impact (${codes.join(", ")}); unknown impact runs the full suite` : "the selector established the impact" };
}

// Every trigger for one resolved plan. `selection` is the plan's selection summary
// (selected_count, suites_total, fallback_reasons as codes), or null when the stage
// or the inputs give no selection to measure.
function evaluateTriggers({ config, landings = [], lastQualified = null, selection = null }) {
  const counter = counterState({ landings, lastQualified, threshold: config.landed_tickets });
  const radius = selection
    ? radiusState({ selected: selection.selected_count, total: selection.suites_total, percent: config.radius_percent })
    : { selected: null, total: null, share_percent: null, threshold_percent: config.radius_percent, measurable: false, fired: false, reason: "not evaluated: this stage runs the full qualification or has no base" };
  const unknown = selection
    ? unknownState({ fallbackCodes: selection.fallback_reasons || [] })
    : { codes: [], fired: false, reason: "not evaluated: this stage runs the full qualification or has no base" };
  const core = selection
    ? coreSurfaceState({ fallbackCodes: selection.fallback_reasons || [] })
    : { codes: [], fired: false, reason: "not evaluated: this stage runs the full qualification or has no base" };
  const fired = [];
  const reasons = [];
  if (counter.fired) { fired.push("counter"); reasons.push(`counter: ${counter.reason}`); }
  if (radius.fired) { fired.push("radius"); reasons.push(`radius: ${radius.reason}`); }
  if (unknown.fired) { fired.push("unknown"); reasons.push(`unknown: ${unknown.reason}`); }
  if (core.fired) { fired.push("core"); reasons.push(`core: ${core.reason}`); }
  return { fired, primary: fired[0] || null, reasons, counter, radius, unknown, core, enforced: false,
    note: "reported only: ADR 0025 acceptance does not switch the PR gate; the decision is unchanged" };
}

module.exports = { UNKNOWN_FALLBACK_CODES, CORE_SURFACE_CODES, counterState, radiusState, unknownState, coreSurfaceState, evaluateTriggers };
