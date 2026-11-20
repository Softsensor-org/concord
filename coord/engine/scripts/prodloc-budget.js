"use strict";

// COORD-957 (ADR 0021): the one production-LOC budget check. The arch-checks gate (`prodloc`
// finding) and the closeout guard (assertProductionLocForCloseout) both decide through this
// module, so a budget means the same thing at both points. Trusted budgets come only from the
// running engine's config; a candidate's declared numbers are data and are never executed here.
const { stripComments } = require("./comment-lexer.js");

const DEFAULT_MAX_LOC = 1200;

function normalizeFindingFilePath(file) {
  return String(file == null ? "" : file).replace(/\\/g, "/").replace(/^\.\//, "");
}

// Counts non-empty lines after comments are stripped. Returns { loc, total }.
function countLoc(source) {
  const text = String(source == null ? "" : source);
  const total = text.length === 0 ? 0 : text.split(/\r?\n/).length;
  const stripped = stripComments(text);
  let loc = 0;
  for (const raw of stripped.split(/\r?\n/)) {
    if (raw.trim().length > 0) loc += 1;
  }
  return { loc, total };
}

function highWaterOf(config) {
  return config && config.highWater && typeof config.highWater === "object" ? config.highWater : {};
}

function maxLocOf(config) {
  return Number.isFinite(Number(config && config.maxLoc)) ? Number(config.maxLoc) : DEFAULT_MAX_LOC;
}

function shouldCheckProductionModuleLoc(file, config = {}) {
  const norm = normalizeFindingFilePath(file);
  if (!norm.endsWith(".js") && !norm.endsWith(".mjs") && !norm.endsWith(".cjs")) return false;
  if (norm.endsWith(".test.js")) return false;
  if (norm.includes("/__fixtures__/")) return false;
  const include = Array.isArray(config.include) && config.include.length
    ? config.include
    : ["coord/scripts/"];
  return include.some((prefix) => norm.startsWith(normalizeFindingFilePath(prefix)));
}

// The budget a file answers to. A trusted budget keyed by its own path wins; a budget carried
// by a registered move or git rename (see prodloc-closeout.js) applies at the trusted legacy
// number; every other path gets the default budget.
function budgetFor(file, { trusted, maxLoc, carried }) {
  if (Object.prototype.hasOwnProperty.call(trusted, file)) return { budget: Number(trusted[file]), carry: null };
  const move = carried.get(file);
  if (move && Object.prototype.hasOwnProperty.call(trusted, move.from)) return { budget: Number(trusted[move.from]), carry: move };
  return { budget: maxLoc, carry: null };
}

// The single LOC decision. Returns null when the file is out of scope or within budget, else
// { file, loc, budget, carry } for the file that exceeds its budget.
function productionLocExcess({ file, source, config, carried = new Map() }) {
  if (!shouldCheckProductionModuleLoc(file, config)) return null;
  const norm = normalizeFindingFilePath(file);
  const { budget, carry } = budgetFor(norm, { trusted: highWaterOf(config), maxLoc: maxLocOf(config), carried });
  const { loc } = countLoc(source);
  return loc > budget ? { file: norm, loc, budget, carry } : null;
}

// Refusal text kept verbatim from the closeout guard (COORD-913 wording).
function measuredRefusalText(file, { loc, budget, carry }) {
  return carry
    ? `${file}: measured ${loc} LOC, declared budget ${budget}: budget carried by a move from ${carry.from} (${carry.kind})`
    : `${file}: measured ${loc} LOC, declared budget ${budget}`;
}

// Refusal text for a candidate-declared number that is above the trusted budget (COORD-913).
function declaredRefusalText(file, number, { budget, carry, trusted }) {
  return Object.prototype.hasOwnProperty.call(trusted, file) || carry
    ? `budget raised: ${file} declares ${number} but the trusted budget is ${budget}${carry ? ` (carried from ${carry.from} by a ${carry.kind})` : ""}; a candidate may not raise a budget`
    : `budget invented for unregistered path ${file}: candidate declares ${number} with no trusted budget and no registered move or git rename; register the move in coord/engine/shim-registry.json or remove the declaration`;
}

module.exports = {
  DEFAULT_MAX_LOC,
  normalizeFindingFilePath,
  countLoc,
  highWaterOf,
  maxLocOf,
  shouldCheckProductionModuleLoc,
  budgetFor,
  productionLocExcess,
  measuredRefusalText,
  declaredRefusalText,
};
