"use strict";

// COORD-273 / COORD-835: the journal-loss guard. With no journal baseline, the
// next governed mutation would anchor whatever is on disk as a new genesis. That
// is right for a genuinely FRESH workspace (no board rows, plan records, prompts,
// rendered views or decision records) and wrong over EXISTING coordination
// state: a deleted journal over live state is the signature of a lost journal or
// of a tamper laundered by removing the events log. Over existing state only a
// packet-bound human-admin reconcile may establish the baseline; every other
// verb, drift-tolerant or not, refuses.

const fs = require("fs");
const path = require("path");

// COORD-835: the decision registry's top-level README.md is the validator's
// derived index. A fresh workspace may carry it only in the exact bytes the ADR
// validator writes before any ADR exists: its default heading alone, or that
// heading followed by the empty index table. Any other README content (a forged
// index row, hand-written prose) is governed state, not a fresh install.
const FRESH_DECISIONS_README_HEADING = "# Decision Records (ADRs)";
const FRESH_DECISIONS_README_EMPTY_INDEX = "## Index\n\n| ADR | Title | Status |\n| --- | --- | --- |";
const FRESH_DECISIONS_README_BYTES = Object.freeze([
  `${FRESH_DECISIONS_README_HEADING}\n`,
  `${FRESH_DECISIONS_README_HEADING}\n\n${FRESH_DECISIONS_README_EMPTY_INDEX}\n`,
]);

function isFreshDecisionsReadme(filePath, fsImpl = fs) {
  return FRESH_DECISIONS_README_BYTES.includes(fsImpl.readFileSync(filePath, "utf8"));
}

// Directory entries are read with lstat semantics (Dirent): a symlink, dangling
// or not and whatever it points at, is state (COORD-835: a symlinked ADR must not
// read as a fresh workspace). Only real directories are descended into, and an
// empty directory tree is fresh. `isExempt(entry, entryPath)` may exempt a
// regular top-level file.
function directoryContainsAnyFile(dirPath, isExempt = () => false, fsImpl = fs) {
  if (!dirPath || !fsImpl.existsSync(dirPath)) return false;
  return fsImpl.readdirSync(dirPath, { withFileTypes: true }).some((entry) => {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) return directoryContainsAnyFile(entryPath, () => false, fsImpl);
    return !(entry.isFile() && isExempt(entry, entryPath));
  });
}

// `isShippedDecisionRecord(filePath)` lets a caller that holds a trusted record
// of the bytes an install shipped (coord init) exempt those top-level decision
// files; every other caller treats every decision record as state.
function governedCoordinationStateExists(paths, fsImpl = fs, { isShippedDecisionRecord = () => false } = {}) {
  // A fresh board is structurally empty (no rows). A board that exists but does
  // not parse, over a missing journal, is itself anomalous: treat it as state.
  try {
    if (paths.BOARD_PATH && fsImpl.existsSync(paths.BOARD_PATH)) {
      const board = JSON.parse(fsImpl.readFileSync(paths.BOARD_PATH, "utf8"));
      const sections = Array.isArray(board?.sections) ? board.sections : [];
      if (sections.some((section) => Array.isArray(section?.rows) && section.rows.length > 0)) return true;
    }
  } catch {
    return true;
  }
  // COORD-835: decision records are governed state too, so an empty board with
  // ADRs is not a fresh workspace; only the validator's fresh README is exempt.
  const freshReadme = (entry, entryPath) => isShippedDecisionRecord(entryPath) ||
    (entry.name === "README.md" && isFreshDecisionsReadme(entryPath, fsImpl));
  return [paths.PLAN_RECORDS_DIR, paths.PROMPTS_DIR, paths.RENDERED_DIR]
    .some((dirPath) => directoryContainsAnyFile(dirPath, undefined, fsImpl)) ||
    directoryContainsAnyFile(paths.DECISIONS_DIR, freshReadme, fsImpl);
}

// The journal-loss guard's state paths for a coord root laid out by paths.js
// (`createCoordPaths`): the same set the governance state object carries.
function coordinationStatePathsFor(coordPaths) {
  return {
    BOARD_PATH: coordPaths.boardPath,
    PLAN_RECORDS_DIR: coordPaths.planRecordsDir,
    PROMPTS_DIR: path.join(coordPaths.coordDir, "prompts"),
    RENDERED_DIR: coordPaths.renderedDir,
    DECISIONS_DIR: coordPaths.decisionsDir,
  };
}

// COORD-835: `gov reconcile` is the only verb that sets `adoptProvenanceDrift`,
// and it reaches the mutation only after requiring --human-admin-override and an
// --expect-paths-file packet for a missing baseline (COORD-722). The generic
// `allowProvenanceDrift` recovery marker (claim, doctor --fix, agentid, recover,
// ...) is NOT an exemption: those verbs repair sessions/locks, never adopt state.
function isPacketBoundBaselineAdoption(metadata) {
  return metadata.command === "manual-reconcile" && metadata.adoptProvenanceDrift === true;
}

const JOURNAL_LOST_RECONCILE_COMMAND =
  'coord/scripts/gov reconcile --reason "<why>" --human-admin-override "<approval for these exact changes>" ' +
  "--expect-paths-file <approved packet from gov reconcile --dry-run>";

function formatJournalLostOverExistingStateMessage() {
  return (
    // guard:seal-journal-drift
    "Refusing to auto-baseline the governance journal: the journal is " +
    "absent/uninitialized, but governed coordination state already exists on disk " +
    "(board ticket rows, plan records, prompts, rendered board artifacts, or decision records). " +
    "This is the signature of a LOST or DELETED journal over LIVE coordination " +
    "state — including possible tampering (an out-of-band edit with the " +
    "events log removed to hide it) — NOT a fresh init. Silently anchoring " +
    "whatever is currently on disk as a new genesis baseline would launder that " +
    "state with no evidence of the loss, so no verb (including recover, claim and " +
    "doctor --fix) establishes it. Investigate the missing journal first " +
    "(`coord/scripts/gov doctor`). To deliberately re-establish the baseline over the " +
    "reviewed on-disk state, run `coord/scripts/gov reconcile --reason \"<why>\" --dry-run`, " +
    `have its expect_paths_packet approved, then run \`${JOURNAL_LOST_RECONCILE_COMMAND}\`.`
  );
}

// What doctor and baseline-less verbs report for an uninitialized journal: the
// generic "run a governed mutation" advice only holds for a fresh workspace.
function formatUninitializedJournalMessage(paths, formatFreshMessage) {
  return governedCoordinationStateExists(paths) ? formatJournalLostOverExistingStateMessage() : formatFreshMessage();
}

module.exports = {
  formatUninitializedJournalMessage,
  directoryContainsAnyFile,
  governedCoordinationStateExists,
  coordinationStatePathsFor,
  FRESH_DECISIONS_README_BYTES,
  isPacketBoundBaselineAdoption,
  formatJournalLostOverExistingStateMessage,
  JOURNAL_LOST_RECONCILE_COMMAND,
};
