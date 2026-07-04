"use strict";

// @coord/shared — public entry point.
//
// COORD-136 (Component-library convergence). This package is the CANONICAL home
// for cross-repo shared utilities/components. Repos (frontend/, the coord-ui
// app, backend/) converge onto these exports instead of each maintaining a
// drifting private copy. The extraction-tuned arch-checks duplication gate
// (lower minLines + cross-repo corpus, ratchet mode) applies the PRESSURE that
// keeps new divergence from growing; this package is where the extracted logic
// LANDS. See coord/docs/QUALITY_DIMENSIONS.md §5 (the boundary section).
//
// Zero runtime dependencies — everything re-exported here is pure.

const format = require("./src/format.js");
const result = require("./src/result.js");

module.exports = {
  ...format,
  ...result,
};
