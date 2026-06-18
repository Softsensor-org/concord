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

function inferNextRound(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return 1;
  }
  return Math.max(...findings.map((finding) => finding.round || 1)) + 1;
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
  todayIso,
  escapeTable,
  escapeRegex,
  shellEscape,
};
