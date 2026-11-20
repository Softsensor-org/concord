"use strict";

// COORD-820: ticket-lock enumeration and lookup, extracted from the
// lifecycle.js composition root to pay for the correct-finding-severity wiring
// under the shrink-only prodloc high-water (no budget bump). Behavior is
// unchanged: lock files are enumerated across every existing lock directory in
// precedence order (the first directory to hold a given file name wins), and a
// ticket's lock is the first one whose identity-normalized payload names it.
// Collaborators are injected so lifecycle.js can pass deferred wrappers for the
// names it binds later in the file.
const fs = require("fs");
const path = require("path");

module.exports = function createLockLookup({ existingLockDirs, normalizeLockIdentityReferences, safeReadJson }) {
  function getLockFiles() {
    const filesByName = new Map();
    for (const dirPath of existingLockDirs()) {
      for (const fileName of fs.readdirSync(dirPath).filter((entry) => entry.endsWith(".lock")).sort()) {
        if (!filesByName.has(fileName)) {
          filesByName.set(fileName, path.join(dirPath, fileName));
        }
      }
    }
    return [...filesByName.values()];
  }

  function findLockForTicket(ticketId) {
    for (const lockPath of getLockFiles()) {
      const lock = normalizeLockIdentityReferences(safeReadJson(lockPath));
      if (lock && lock.ticket === ticketId) {
        return { path: lockPath, ...lock };
      }
    }
    return null;
  }

  return { getLockFiles, findLockForTicket };
};
