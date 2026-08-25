"use strict";

// COORD-669: testing-infrastructure PATH/TOKEN primitives, extracted out of the
// lifecycle.js composition root.
//
// WHY THIS MODULE EXISTS
//
// COORD-396/397 established coord/scripts/lifecycle.js as a MEASURED pure
// composition root, and COORD-395 hardened the arch-checks prodloc high-water
// into a strict, no-grandfather, DOWNWARD ratchet. COORD-663 (bf8f5db4) added
// two legitimate wiring lines for the `normalizeLock` verb, which pushed the
// root from 2464 (exactly at budget) to 2466 (breach by 2). Per COORD-446 and
// the COORD-594 precedent (4e950b9d) the remedy for a breached root is
// EXTRACTION with the budget ratcheted DOWN to the newly measured size, never a
// budget bump.
//
// The four helpers below were the clearest non-wiring residents left in the
// root: pure string/path/token predicates with no lifecycle state, and already
// treated as injected collaborators by createTestingInfraAudit (COORD-283) and
// by governance-validation.js. They are moved VERBATIM — no behavior, message,
// signature or return shape changes.
//
// COLLABORATOR ORDERING
//
// `extractFileReferencesFromCommands` needs `normalizeTestingInfraAuditPath`,
// which lifecycle.js constructs LATER via createTestingInfraAudit — and
// createTestingInfraAudit in turn needs three of the helpers returned here. The
// cycle is broken the same way the rest of the root breaks it: both directions
// are injected as deferred `(...a) => fn(...a)` wrappers that resolve at CALL
// time, so factory construction order is irrelevant.

/**
 * File-path patterns that mark a path as testing infrastructure. Kept next to
 * the predicate that consumes it so the vocabulary and its matcher cannot drift.
 */
const TESTING_INFRA_FILE_PATTERNS = [
  /^tools\/(?:gates|testing|hooks)\//,
  /^tests\/(?:arch|setup|components|contracts)\//,
  /^packages\/testkit\//,
  /^vitest\.config\.[cm]?[jt]sx?$/,
  /^package\.json$/,
  /^README\.md$/,
  /^\.github\/workflows\//,
  /^\.husky\//,
];

function createTestingInfraPaths({
  normalizeTestingInfraAuditPath,
  toArray,
}) {
  function tokenizeShellWords(value) {
    return (String(value || "").match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|[^\s]+/g) || [])
      .map((token) => token.replace(/^['"]|['"]$/g, ""));
  }

  function splitPlanPathValues(values) {
    return toArray(values)
      .flatMap((entry) => String(entry || "").split(","))
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  }

  function isTestingInfrastructureFilePath(value) {
    const normalized = String(value || "").trim().replace(/\\/g, "/");
    return TESTING_INFRA_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  function extractFileReferencesFromCommands(ticketId, row, commands) {
    const files = new Set();
    for (const command of commands || []) {
      const tokens = tokenizeShellWords(command);
      for (const token of tokens) {
        const cleaned = String(token || "")
          .replace(/^[([{"'`]+/, "")
          .replace(/[)\]}",;:'`]+$/, "")
          .trim();
        if (!cleaned || /^https?:\/\//.test(cleaned) || !/\.[A-Za-z0-9]+$/.test(cleaned)) {
          continue;
        }
        const normalized = normalizeTestingInfraAuditPath(row.Repo, ticketId, cleaned);
        if (normalized && isTestingInfrastructureFilePath(normalized)) {
          files.add(normalized);
        }
      }
    }
    return [...files];
  }

  return {
    extractFileReferencesFromCommands,
    isTestingInfrastructureFilePath,
    splitPlanPathValues,
    tokenizeShellWords,
  };
}

module.exports = createTestingInfraPaths;
module.exports.TESTING_INFRA_FILE_PATTERNS = TESTING_INFRA_FILE_PATTERNS;
