"use strict";

// Project-owned development records belong to the donor workspace, not to a
// downstream installation or release artifact. Keep this list shared by the
// installer and release tooling so the boundary has one owner.
const PROJECT_OWNED_PATHS = Object.freeze([
  "coord/prompts/tickets",
  "coord/PLAN.md",
  "coord/rendered/TASKS.md",
  "coord/rendered/PROMPT_INDEX.md",
]);

function isProjectOwnedPath(relative) {
  const normalized = String(relative).replace(/\\/g, "/").replace(/\/+$/, "");
  return PROJECT_OWNED_PATHS.some(root => normalized === root || normalized.startsWith(`${root}/`));
}

module.exports = { PROJECT_OWNED_PATHS, isProjectOwnedPath };
