"use strict";

// Continuity cockpit model (COORD-406) — read-only readout for the /continuity UI.
//
// There is intentionally no parallel continuity logic here: the DEFINED object
// shapes are reused from governance-context.js (CONTINUITY_ARTIFACT_SHAPES, the
// CONTINUITY_PROFILE contract). This module only adds a coverage SCAN over plan
// records and the journal, so the readout honestly reflects adoption state —
// today that is "shapes defined, no records yet". Pure read; mutates nothing.

const fs = require("node:fs");
const path = require("node:path");

const COCKPIT_KIND = "concord.continuity.cockpit_model";

function loadShapes() {
  try {
    const gc = require("./governance-context.js");
    return gc.CONTINUITY_ARTIFACT_SHAPES || {};
  } catch {
    return {};
  }
}

function hasData(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return String(value).trim().length > 0;
}

// A continuity block counts only when it is present AND carries data, anywhere
// in the record (the fields are nested under various plan blocks).
function detectContinuity(record) {
  let warm = false;
  let cold = false;
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (/^warm_start$/i.test(key) && hasData(value)) warm = true;
      if (/^cold_finish$/i.test(key) && hasData(value)) cold = true;
      if (value && typeof value === "object") walk(value);
    }
  })(record);
  return { warm, cold };
}

function scanPlanRecords(plansDir) {
  let files = [];
  try {
    files = fs.readdirSync(plansDir).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  let scanned = 0;
  let withWarm = 0;
  let withCold = 0;
  const records = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(plansDir, file), "utf8"));
    } catch {
      continue;
    }
    scanned += 1;
    const { warm, cold } = detectContinuity(parsed);
    if (warm) withWarm += 1;
    if (cold) withCold += 1;
    if (warm || cold) {
      records.push({
        ticket: parsed.ticket || parsed.id || file.replace(/\.json$/, ""),
        warm_start: warm,
        cold_finish: cold,
      });
    }
  }
  return { scanned, withWarm, withCold, records };
}

function scanContinuityEvents(journalPath, limit = 10) {
  let lines = [];
  try {
    lines = fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const re = /(warm.?start|cold.?finish|continuity)/i;
  const events = [];
  for (let i = lines.length - 1; i >= 0 && events.length < limit; i -= 1) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (re.test(event.command || "")) {
      events.push({
        command: event.command,
        ticket: event.ticket || null,
        recorded_at: event.recorded_at || null,
      });
    }
  }
  return events;
}

function buildContinuityCockpitModel(options = {}) {
  const shapesObj = loadShapes();
  const shapes = Object.entries(shapesObj).map(([id, def]) => ({
    shape: id,
    scope: def && def.scope ? def.scope : "",
    warm_start_fields: def && Array.isArray(def.warm_start) ? def.warm_start : [],
    cold_finish_fields: def && Array.isArray(def.cold_finish) ? def.cold_finish : [],
  }));
  const coverage = options.plansDir
    ? scanPlanRecords(options.plansDir)
    : { scanned: 0, withWarm: 0, withCold: 0, records: [] };
  const recentEvents = options.journalPath ? scanContinuityEvents(options.journalPath) : [];
  return {
    kind: COCKPIT_KIND,
    schema_version: 1,
    mode: "read-only",
    summary: {
      defined_shapes: shapes.length,
      plan_records_scanned: coverage.scanned,
      with_warm_start: coverage.withWarm,
      with_cold_finish: coverage.withCold,
      with_any_continuity: coverage.records.length,
      recent_events: recentEvents.length,
    },
    shapes,
    records: coverage.records,
    recent_events: recentEvents,
    adoption_note:
      coverage.records.length === 0 && recentEvents.length === 0
        ? "Continuity object shapes are defined, but no warm-start/cold-finish records or continuity events exist yet — handoff continuity is not in active use. See CONTINUITY_PROFILE.md and TEAM_CONTINUITY_ROLLOUT.md."
        : null,
  };
}

module.exports = { buildContinuityCockpitModel, COCKPIT_KIND };
