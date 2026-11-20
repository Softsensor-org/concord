"use strict";

const fs = require("node:fs");
const path = require("node:path");

// createCoordPaths intentionally fails closed unless a coord root contains the
// engine-owned board schemas, and CLI fixtures may load other engine modules.
// Synthetic roots install the canonical engine tree instead of weakening that
// production boundary or drifting from its current module set. An optional
// fs.cpSync filter lets a fixture leave out source-only files it never loads.
function installCanonicalEngine(coordDir, sourceCoordDir, filter) {
  fs.mkdirSync(coordDir, { recursive: true });
  fs.cpSync(
    path.join(sourceCoordDir, "engine"),
    path.join(coordDir, "engine"),
    { recursive: true, filter }
  );
}

module.exports = { installCanonicalEngine };
