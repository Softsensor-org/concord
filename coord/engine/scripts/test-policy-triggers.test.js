"use strict";

// COORD-974 (ADR 0025 decision 2): the full-suite triggers reported by
// `gov test-policy resolve`: the landed-ticket counter, the radius threshold and
// the unknown selector fallback. Pure functions, fixture inputs only.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const triggers = require("./test-policy-triggers.js");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "test-policy.json"), "utf8")).full_suite_triggers;
const at = (day, hour = 0) => `2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
// n landings recorded at consecutive hours from the given day.
const landings = (n, day = 16) => Array.from({ length: n }, (_, i) => ({ ticket: `COORD-${900 + i}`, recorded_at: at(day, i % 24) }));

test("COORD-974: the shipped policy stores the ADR 0025 thresholds: 10 landed tickets and 70 percent of suites", () => {
  assert.equal(CONFIG.landed_tickets, 10);
  assert.equal(CONFIG.radius_percent, 70);
});

test("COORD-974 counter: 9 landed since the last full run does not fire; 10 fires", () => {
  const last = { at: at(15) };
  const nine = triggers.counterState({ landings: landings(9), lastQualified: last, threshold: 10 });
  const ten = triggers.counterState({ landings: landings(10), lastQualified: last, threshold: 10 });
  assert.deepEqual([nine.landed_since, nine.fired], [9, false]);
  assert.deepEqual([ten.landed_since, ten.fired], [10, true]);
  assert.match(ten.reason, /10 tickets landed on dev since the last full run at .* threshold of 10 is reached/);
});

test("COORD-974 counter: landings recorded at or before the last full run are not counted; the counter resets after a full run", () => {
  const before = landings(12, 14);
  const after = landings(3, 17);
  const beforeRun = triggers.counterState({ landings: [...before, ...after], lastQualified: { at: at(15) }, threshold: 10 });
  assert.deepEqual([beforeRun.landed_since, beforeRun.fired], [3, false]);
  // A full run recorded after the last landing resets the count to zero.
  const reset = triggers.counterState({ landings: [...before, ...after], lastQualified: { at: at(18) }, threshold: 10 });
  assert.deepEqual([reset.landed_since, reset.fired], [0, false]);
  // A landing exactly at the full run's timestamp was part of that run: not counted.
  const boundary = triggers.counterState({ landings: [{ ticket: "COORD-1", recorded_at: at(15) }], lastQualified: { at: at(15) }, threshold: 1 });
  assert.equal(boundary.landed_since, 0);
});

test("COORD-974 counter: with no recorded full run every landing counts, so the counter fires at 10", () => {
  const none = triggers.counterState({ landings: landings(10), lastQualified: null, threshold: 10 });
  assert.deepEqual([none.baseline_at, none.landed_since, none.fired], [null, 10, true]);
  assert.match(none.reason, /no passing full run recorded/);
});

test("COORD-974 radius: 69.9 percent does not fire the 70 percent threshold; 70.1 percent fires", () => {
  const under = triggers.radiusState({ selected: 699, total: 1000, percent: 70 });
  const over = triggers.radiusState({ selected: 701, total: 1000, percent: 70 });
  assert.deepEqual([under.share_percent, under.fired], [69.9, false]);
  assert.deepEqual([over.share_percent, over.fired], [70.1, true]);
});

test("COORD-974 radius: exactly 70 percent does not fire (the threshold is exceeded, not reached); the measured five diffs stay below it", () => {
  assert.equal(triggers.radiusState({ selected: 700, total: 1000, percent: 70 }).fired, false);
  for (const [selected, total] of [[260, 389], [259, 391], [258, 390], [266, 391], [260, 392]]) {
    assert.equal(triggers.radiusState({ selected, total, percent: 70 }).fired, false, `${selected}/${total}`);
  }
});

test("COORD-974 radius: a selection that cannot be measured is not a radius trigger but is reported as unmeasured", () => {
  const none = triggers.radiusState({ selected: null, total: null, percent: 70 });
  assert.deepEqual([none.measurable, none.fired], [false, false]);
  assert.match(none.reason, /not measurable/);
});

test("COORD-974 unknown: only the unknown selector fallback codes fire; T2 surfaces and guards are reported elsewhere", () => {
  for (const code of ["dynamic_dependency", "unknown_dependents", "incomplete_analysis", "unattributed_generated"]) {
    assert.equal(triggers.unknownState({ fallbackCodes: [code] }).fired, true, code);
  }
  for (const code of ["t2_surface", "always_enforced_guard"]) {
    assert.equal(triggers.unknownState({ fallbackCodes: [code] }).fired, false, code);
  }
  assert.equal(triggers.unknownState({ fallbackCodes: [] }).fired, false);
  assert.deepEqual(triggers.unknownState({ fallbackCodes: ["t2_surface", "dynamic_dependency"] }).codes, ["dynamic_dependency"]);
});

test("COORD-974 evaluate: names every trigger that fired, in order, with its reason; reports only (the plan decision is unchanged)", () => {
  const selection = { selected_count: 800, suites_total: 1000, fallback_reasons: ["dynamic_dependency"] };
  const out = triggers.evaluateTriggers({ config: CONFIG, landings: landings(10), lastQualified: { at: at(15) }, selection });
  assert.deepEqual(out.fired, ["counter", "radius", "unknown"]);
  assert.equal(out.primary, "counter");
  assert.equal(out.enforced, false);
  assert.equal(out.reasons.length, 3);
});

test("COORD-974 evaluate: nothing fired reports none; a stage that runs the full qualification has no selection to measure", () => {
  const quiet = triggers.evaluateTriggers({ config: CONFIG, landings: landings(2), lastQualified: { at: at(15) }, selection: { selected_count: 260, suites_total: 389, fallback_reasons: [] } });
  assert.deepEqual([quiet.fired, quiet.primary], [[], null]);
  const sparse = triggers.evaluateTriggers({ config: CONFIG, selection: { selected_count: 2, suites_total: 20 } });
  assert.deepEqual([sparse.unknown, sparse.core], [quiet.unknown, quiet.core]);
  assert.deepEqual(sparse.fired, []);
  const notEvaluated = triggers.evaluateTriggers({ config: CONFIG, landings: landings(2), lastQualified: { at: at(15) }, selection: null });
  assert.equal(notEvaluated.radius.measurable, false);
  assert.equal(notEvaluated.unknown.fired, false);
  assert.match(notEvaluated.radius.reason, /not evaluated/);
});

// COORD-1031 (ADR 0025 decision 2(b)): the core-surface trigger.
test("COORD-1031 core: a core_surface fallback fires the core trigger; other fallbacks do not", () => {
  const core = triggers.coreSurfaceState({ fallbackCodes: ["core_surface"] });
  assert.equal(core.fired, true);
  assert.deepEqual(core.codes, ["core_surface"]);
  assert.equal(triggers.coreSurfaceState({ fallbackCodes: ["t2_surface", "always_enforced_guard"] }).fired, false);
});

test("COORD-1031 core: evaluateTriggers reports core alongside the other triggers", () => {
  const selection = { selected_count: 10, suites_total: 100, fallback_reasons: ["core_surface"] };
  const t = triggers.evaluateTriggers({ config: CONFIG, landings: [], lastQualified: null, selection });
  assert.ok(t.fired.includes("core"));
  assert.equal(t.enforced, false);
  const none = triggers.evaluateTriggers({ config: CONFIG, landings: [], lastQualified: null, selection: { ...selection, fallback_reasons: [] } });
  assert.equal(none.fired.includes("core"), false);
});
