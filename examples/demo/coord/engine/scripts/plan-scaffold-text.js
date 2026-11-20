"use strict";

// COORD-690: the single source of truth for the placeholder text the engine
// itself writes into a plan record at `gov start`.
//
// This table used to live inline in plan-records.js, where only the WRITER
// could see it. Nothing on the closeout side could ask "is this value still the
// scaffold I emitted?", so the closeout gate confirmed the field was populated
// and never that it said anything — and the value it accepted was one the
// engine had written. `requirement_closure` was measured passing
// `gov guided-closeout` while still entirely scaffold (COORD-690), the same
// presence-not-content shape as COORD-677/678.
//
// Extracting the table makes the reader and the writer share one definition, so
// a gate can reject EXACTLY the text the engine emits rather than a
// hand-maintained copy that drifts away from it.
const PLAN_SCAFFOLD_LIST_VALUES = Object.freeze({
  startup_checklist: [
    "TODO: completed",
  ],
  traceability_gate: [
    "TODO: verified | closing-gap | exempt",
  ],
  baseline_reproduction: [
    "TODO: Command: <required for test/contract/infra tickets; otherwise mark not-required>",
    "TODO: Outcome: <required for test/contract/infra tickets; otherwise mark not-required>",
  ],
  change_summary: [
    "TODO: describe the intended change.",
  ],
  verification_commands: [
    "TODO",
  ],
  critical_invariants: [
    "TODO: list 2-5 truths this change must preserve under normal, edge, and failure paths",
    "TODO: include at least one invariant about state/contract consistency",
    "TODO: list 2-5 truths this repair must preserve under normal, edge, and failure paths",
  ],
  requirement_closure: [
    "TODO: Ticket ask: <what the ticket said to deliver>",
    "TODO: Implemented: <what is actually delivered in this change>",
    "TODO: Not implemented: <residual gap or none>",
    "TODO: Deferred to: <ticket-id or none>",
    "TODO: Closeout verdict: complete | incomplete",
  ],
  feature_proof: [
    "TODO: path:<repo-relative-file-that-must-exist-on-canonical-branch>",
    "TODO: symbol:<repo-relative-file>#<symbol-or-literal-that-must-exist-at-closeout>",
  ],
  repo_gates: [
    "TODO: add executed repo gate(s) before move-review, or not-required for coord-only tickets",
  ],
  rollback_strategy: [
    "TODO",
  ],
});

// The scaffold text for a key, indexed for O(1) exact-match rejection. Both the
// raw scaffold line and the line with its leading "TODO: " marker stripped are
// indexed: `splitRequirementClosure` in the closeout gate strips that marker
// before comparing, which is precisely how the scaffold slipped through.
const SCAFFOLD_VALUE_INDEX = new Map(
  Object.entries(PLAN_SCAFFOLD_LIST_VALUES).map(([key, values]) => {
    const index = new Set();
    for (const value of values) {
      const text = String(value).trim();
      index.add(text);
      index.add(text.replace(/^TODO:\s*/i, ""));
    }
    return [key, index];
  })
);

// True when `value` is verbatim scaffold text the engine emitted for `key`,
// with or without its "TODO: " marker.
function isPlanScaffoldValue(key, value) {
  const index = SCAFFOLD_VALUE_INDEX.get(key);
  if (!index) {
    return false;
  }
  return index.has(String(value || "").trim());
}

// True when `value` is unfilled boilerplate rather than an answer, judged on
// SHAPE rather than on an exact match against the table above. This catches the
// three ways a placeholder reaches a gate:
//   - the raw "TODO: ..." marker the engine writes;
//   - an angle-bracket template ("<what the ticket said to deliver>") left in
//     place after the marker was stripped or hand-removed;
//   - an enum MENU echoed back instead of a choice made from it
//     ("complete | incomplete", "verified | closing-gap | exempt").
// An empty value is boilerplate too: there is nothing there to have said.
function isUnfilledPlaceholderText(value) {
  const text = String(value || "").trim();
  if (!text) {
    return true;
  }
  if (/^todo\b/i.test(text)) {
    return true;
  }
  if (/^<[^<>]*>$/.test(text)) {
    return true;
  }
  if (isEnumMenuEcho(text)) {
    return true;
  }
  return false;
}

// An enum menu is a pipe-separated list of bare words — the options offered by
// the scaffold. A real answer picks one; it does not restate the list. The
// word-shape requirement keeps a genuine prose value that happens to contain a
// pipe from being rejected.
function isEnumMenuEcho(value) {
  const text = String(value || "").trim();
  if (!text.includes("|")) {
    return false;
  }
  const options = text.split("|").map((entry) => entry.trim());
  return options.length >= 2 && options.every((entry) => /^[a-z][a-z-]*$/i.test(entry));
}

module.exports = {
  PLAN_SCAFFOLD_LIST_VALUES,
  isEnumMenuEcho,
  isPlanScaffoldValue,
  isUnfilledPlaceholderText,
};
