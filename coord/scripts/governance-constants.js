"use strict";

// COORD-071: shared governance constants + tiny helpers.
//
// These values were previously re-typed in more than one engine module
// (lifecycle.js and governance-repair.js each defined their own copies of the
// stalled-lock / template-feedback windows and the trigger pattern). Defining
// them once here removes the silent-drift risk where one copy is tuned and the
// other is forgotten. Engine-managed; not a project config seam.

// 24h: a ticket lock whose heartbeat is older than this is considered stalled.
const STALLED_LOCK_MS = 24 * 60 * 60 * 1000;

// 7d: a template-feedback alert older than this window is treated as stale.
const TEMPLATE_FEEDBACK_STALE_MS = 7 * 24 * 60 * 60 * 1000;

// Matches free-text describing governance/template-engine surfaces, used to
// decide whether a done coord/X ticket should prompt for template feedback.
const TEMPLATE_FEEDBACK_TRIGGER_PATTERN =
  /\b(governance|coord-template|template feedback|template structure|skill|slash command|\/next|\/do|\/code-writer|agentid|whoami|review-round|base-ref|session|lock|worktree|orchestrator|doctor|orch|questions\.md|log-question)\b/i;

// COORD-074: canonical board-status string constants. These exact literal
// values are the ON-DISK status strings written to board/tasks.json and the
// ticket locks, and they must remain byte-identical to the schema enum and to
// every serialized status the engine has ever produced. Centralizing the
// literals here removes the ~150-site re-typing risk without changing any
// value. NB: blocking is NOT a standalone board status — a blocked ticket is
// stored as `doing (blocked: <reason>)`, i.e. a "doing"-prefixed value (see
// isDoingStatus / the `/^doing \(blocked: .+\)$/` predicate). STATUS.BLOCKED is
// provided for completeness/consumers that want the bare token, but it is not a
// member of ORDERED_STATUSES / LEGAL_STATUSES.
const STATUS = Object.freeze({
  TODO: "todo",
  DOING: "doing",
  REVIEW: "review",
  DONE: "done",
  DEFERRED: "deferred",
  SUPERSEDED: "superseded",
  BLOCKED: "blocked",
});

// The canonical ordered list of legal board statuses (the enum order used by
// board.js, cli.js and lifecycle.js). Order is preserved for parity with the
// previously-inline Sets.
const ORDERED_STATUSES = Object.freeze([
  STATUS.TODO,
  STATUS.DOING,
  STATUS.REVIEW,
  STATUS.DONE,
  STATUS.DEFERRED,
  STATUS.SUPERSEDED,
]);

// Factory (not a shared singleton) so callers that previously owned a private
// `new Set([...])` keep an independent, mutation-safe instance.
function legalStatusSet() {
  return new Set(ORDERED_STATUSES);
}

// Statuses a ticket can be re-opened / scheduled from.
const OPENABLE_STATUSES = Object.freeze([STATUS.TODO, STATUS.DEFERRED]);

// Terminal (closed) board statuses.
const TERMINAL_STATUSES = Object.freeze([STATUS.DONE, STATUS.SUPERSEDED]);

// Canonical finding-status constants + ordered list.
const FINDING_STATUS = Object.freeze({
  OPEN: "open",
  RESOLVED: "resolved",
  DEFERRED: "deferred",
  CONSOLIDATED: "consolidated",
});

const ORDERED_FINDING_STATUSES = Object.freeze([
  FINDING_STATUS.OPEN,
  FINDING_STATUS.RESOLVED,
  FINDING_STATUS.DEFERRED,
  FINDING_STATUS.CONSOLIDATED,
]);

function legalFindingStatusSet() {
  return new Set(ORDERED_FINDING_STATUSES);
}

// COORD-075 (QGATE-001): canonical gate-lane vocabulary — the single source of
// truth for the lane names accepted by `gov gate --lane`, implemented by the
// template repo runners (`scripts/gate.sh <lane>`), and exercised by CI.
//
// Historically coord validated `default | full | extended` while the repo
// gate.sh runners (and the BOOTSTRAP_CONTRACT they implement) accepted
// `default | full | ci`. That made `gov gate --lane ci` rejected by coord and
// `extended` an accepted-but-unimplemented phantom (no gate.sh case, no
// `gate:extended` npm script, not in BOOTSTRAP_CONTRACT). Converging on the
// runner contract eliminates both the implemented-but-rejected (`ci`) and the
// accepted-but-unimplemented (`extended`) drift. `extended` survives only as a
// *policy* concept in TESTING_AND_GATES.md (deeper/release-cut coverage that a
// project folds into its `ci`/`full` lanes); it is no longer an accepted
// `--lane` value. Defining the set here (not re-typed in gate-runtime.js /
// governance-mcp.js / docs-parity tests) is what prevents this contract from
// silently drifting again — see gate-vocab-contract.test.js.
const GATE_LANES = Object.freeze(["default", "full", "ci"]);

function gateLaneSet() {
  return new Set(GATE_LANES);
}

// COORD-079 (QGATE-005): canonical gate-invocation contract for deploy/CI
// workflows. Deploy pipelines historically hand-maintained a partial list of
// test/build commands and ended up WEAKER than the PR gate, so coord stopped
// being the single source of truth. The rule: any pipeline that gates a
// deploy (or runs CI for a repo) MUST invoke the repo's canonical gate runner
// — `bash <repo>/scripts/gate.sh <lane>` (or the governed `gov gate <repo>
// --lane <lane>`) — instead of re-listing the underlying commands. The
// deploy/pre-landing confidence lanes are `full` and `ci` (never the cheap
// `default` lane), so a deploy gate is never weaker than the PR gate.
//
// Single-sourcing the entrypoint + accepted-lanes here (not re-typed in the
// deploy workflow template, the drift-check test, and the docs) is what keeps
// the deploy gate, the PR gate, and the contract test from silently drifting.
// The drift-check (deploy-gate-contract.test.js) asserts the deploy workflow
// template matches CANONICAL_GATE_ENTRYPOINTS and uses a DEPLOY_GATE_LANE; a
// hand-rolled partial command list fails it.
const CANONICAL_GATE_ENTRYPOINTS = Object.freeze([
  // The per-repo bash gate runner (the BOOTSTRAP_CONTRACT entrypoint).
  /\bscripts\/gate\.sh\s+(default|full|ci)\b/,
  // The governed clean-checkout gate.
  /\bgov\s+gate\b[^\n]*--lane\s+(default|full|ci)\b/,
]);

// The lanes a deploy/CI gate is allowed to run. Excludes `default` (the cheap
// review-handoff lane): a deploy gate must be at least as strong as the
// pre-landing PR gate.
const DEPLOY_GATE_LANES = Object.freeze(["full", "ci"]);

function deployGateLaneSet() {
  return new Set(DEPLOY_GATE_LANES);
}

// Escape an arbitrary string for safe embedding in a RegExp source.
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  STALLED_LOCK_MS,
  TEMPLATE_FEEDBACK_STALE_MS,
  TEMPLATE_FEEDBACK_TRIGGER_PATTERN,
  STATUS,
  ORDERED_STATUSES,
  OPENABLE_STATUSES,
  TERMINAL_STATUSES,
  legalStatusSet,
  FINDING_STATUS,
  ORDERED_FINDING_STATUSES,
  legalFindingStatusSet,
  GATE_LANES,
  gateLaneSet,
  CANONICAL_GATE_ENTRYPOINTS,
  DEPLOY_GATE_LANES,
  deployGateLaneSet,
  escapeRegExp,
};
