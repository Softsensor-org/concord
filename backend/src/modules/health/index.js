"use strict";
// Health module (BE-001) — the reference module that establishes the module
// boundary convention. Each feature module exposes a small, testable surface
// and never reaches across into another module's internals.
//
// Boundary rule: modules depend on `src/config` and `src/auth` (shared seams),
// not on each other's files. Cross-module calls go through exported functions.

/**
 * @param {{ now?: () => number }} [deps]
 * @returns {{ status: "ok", uptimeMs: number }}
 */
function getHealth(deps = {}) {
  const now = deps.now || Date.now;
  return { status: "ok", uptimeMs: Math.round(now() - START) };
}

const START = Date.now();

module.exports = { getHealth };
