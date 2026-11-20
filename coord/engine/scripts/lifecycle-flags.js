"use strict";

// B4 decomposition slice: CLI flag parsing for lifecycle subcommands,
// extracted from lifecycle.js. parseLifecycleFlags translates a verb's raw
// argv into a normalized options object; requireValue/appendValue are its
// internal helpers. Factory-injected (fail, isLegalStatus) so it stays free of
// lifecycle-module coupling.

const path = require("path");
const {
  SHARED_VALUE_FLAGS,
  SHARED_APPEND_FLAGS,
  SHARED_SCALAR_TEXT_FILE_FIELDS,
  SHARED_BOOL_FLAGS,
  appendValue,
  createSharedSpecialFlags,
  parseFlagTables,
} = require("./flag-tables.js");
const { resolveEngineModule } = require("../../paths.js");
const { createSafeTextInput } = require(resolveEngineModule(
  path.resolve(__dirname, "..", ".."),
  "scripts/safe-text-input.js",
));
const { defaultFail } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-context.js"));
// COORD-094: parseLifecycleFlags was a ~650-line / ~130-case switch identical
// in structure to cli.js's parseFlags. The flag spec is DATA. COORD-984
// (ARCH-AUDIT F-04): the identical flag-to-key pairs shared with cli.js now live
// once in flag-tables.js, which both parsers import. The lifecycle parser's
// scalar behavior for --depends-on and --parent stays here.
const LIFECYCLE_VALUE_FLAGS = Object.freeze({
  ...SHARED_VALUE_FLAGS,
  "--depends-on": "dependsOn",
  "--parent": "dependsOn",
  // COORD-557: set-context-pack-ack authoring flags.
  // COORD-572: parity with cli.js for the JSON-object plan fields whose writer
  // was previously unreachable from any flag token.
});

const LIFECYCLE_APPEND_FLAGS = Object.freeze({
  ...SHARED_APPEND_FLAGS,
});

const LIFECYCLE_SCALAR_TEXT_FILE_FIELDS = SHARED_SCALAR_TEXT_FILE_FIELDS;

const LIFECYCLE_BOOL_FLAGS = Object.freeze({
  ...SHARED_BOOL_FLAGS,
  // COORD-667: parity with cli.js — Repo-X closeout's in-process workspace merge.
  // COORD-222: opt out of the fail-closed "one governed writer per
  // checkout/runtime" guard on `gov start` / `gov claim` (default fail-closed).
});

module.exports = function createLifecycleFlags(deps = {}) {
  const fail = deps.fail || defaultFail;
  const { isLegalStatus, LEGAL_FINDING_STATUSES } = deps;
  const { readUtf8TextFile } = createSafeTextInput({ fail });

  // COORD-094: keep the lifecycle parser's special flag ordering.
  const commonFlagHandlers = createSharedSpecialFlags({ fail, requireValue, isLegalStatus, LEGAL_FINDING_STATUSES });
  const SPECIAL = {
    "--status": commonFlagHandlers.status,
    "--severity": commonFlagHandlers.severity,
    "--base": commonFlagHandlers.base,
    "--reason": commonFlagHandlers.reason,
    "--note": commonFlagHandlers.note,
    "--selection-manifest": commonFlagHandlers.selectionManifest,
    "--result": commonFlagHandlers.result,
    "--base-result": commonFlagHandlers.baseResult,
    "--replace-review-cycle": commonFlagHandlers.replaceReviewCycle,
    "--drop-review-cycle": commonFlagHandlers.dropReviewCycle,
  };

  function parseLifecycleFlags(args) {
    return parseFlagTables(args, {
      valueFlags: LIFECYCLE_VALUE_FLAGS, appendFlags: LIFECYCLE_APPEND_FLAGS, boolFlags: LIFECYCLE_BOOL_FLAGS,
      scalarTextFields: LIFECYCLE_SCALAR_TEXT_FILE_FIELDS, specialFlags: SPECIAL,
      fail, requireValue, readUtf8TextFile,
    });
  }

  function requireValue(flag, value) {
    if (!value) {
      fail(`${flag} requires a value.`);
    }
  }
  
  // COORD-984: effective flag tables, for the table-equivalence test.
  const flagTables = {
    VALUE_FLAGS: LIFECYCLE_VALUE_FLAGS,
    APPEND_FLAGS: LIFECYCLE_APPEND_FLAGS,
    SCALAR_TEXT_FILE_FIELDS: LIFECYCLE_SCALAR_TEXT_FILE_FIELDS,
    BOOL_FLAGS: LIFECYCLE_BOOL_FLAGS,
    SPECIAL_KEYS: Object.keys(SPECIAL),
  };
  return { parseLifecycleFlags, requireValue, appendValue, flagTables };
};
