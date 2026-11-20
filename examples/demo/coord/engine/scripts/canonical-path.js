"use strict";

// COORD-1015: git reports canonical paths (`rev-parse --show-toplevel`, `worktree list`,
// `--git-common-dir`). A caller path may reach the same directory through a symlinked
// parent (macOS /var -> /private/var, a symlinked TMPDIR). Compare canonical forms.

const fs = require("fs");
const path = require("path");

// The canonical absolute form of `candidate`: the realpath of its deepest existing
// ancestor with the missing tail re-attached, so a path whose leaf does not exist yet
// (a vanished worktree, a not-yet-created coord/) still compares correctly.
function canonicalCallerPath(candidate) {
  const absolute = path.resolve(candidate);
  let current = absolute;
  const missing = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

module.exports = { canonicalCallerPath };
