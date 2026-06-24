"use strict";

// @coord/shared — formatting utilities.
//
// COORD-136 (Component-library convergence). These are representative examples
// of LOGIC that tends to be re-implemented independently in each repo (the
// frontend, the coord-ui app, and the backend each grow their own slightly
// different copy of "format bytes" / "truncate" / "pluralize"). They live here
// as the CANONICAL home so callers converge onto one implementation instead of
// drifting. Zero runtime dependencies — pure functions only.

// Human-readable byte size. e.g. formatBytes(1536) -> "1.5 KB".
function formatBytes(bytes, decimals = 1) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), units.length - 1);
  const value = n / Math.pow(k, i);
  const fixed = i === 0 ? String(Math.round(value)) : value.toFixed(decimals);
  return `${fixed} ${units[i]}`;
}

// Truncate a string to maxLen characters, appending an ellipsis when cut. The
// ellipsis is included in the budget so the result never exceeds maxLen.
function truncate(text, maxLen, ellipsis = "…") {
  const s = String(text == null ? "" : text);
  const max = Number(maxLen);
  if (!Number.isFinite(max) || max <= 0 || s.length <= max) return s;
  if (ellipsis.length >= max) return ellipsis.slice(0, max);
  return s.slice(0, max - ellipsis.length) + ellipsis;
}

// Pluralize a noun by count. pluralize(1, "ticket") -> "1 ticket";
// pluralize(3, "ticket") -> "3 tickets". An explicit plural form overrides the
// naive "+s" rule.
function pluralize(count, singular, plural) {
  const n = Number(count);
  const word = n === 1 ? singular : (plural != null ? plural : `${singular}s`);
  return `${n} ${word}`;
}

module.exports = { formatBytes, truncate, pluralize };
