"use strict";

// COORD-703 — the ordering rule for irreversible outward acts, in ONE place.
//
// THE RULE. Everything locally fallible completes BEFORE anything outward
// happens. An act that cannot be undone — a GitHub merge, an in-process
// workspace integration, a push — runs only after every check that could refuse
// the operation has already passed.
//
// WHY IT IS SHARED RATHER THAN RESTATED PER VERB. The same defect has now been
// found at three different verbs: `gov submit` performed PR side effects before
// completing fallible validation (COORD-697), `gov land` merged before
// validating required provenance (this ticket, measured on CONS-025 where PR #12
// was squash-merged and the landing then failed provenance validation and rolled
// the governed files back — leaving a merged PR with no board record), and the
// COORD-706 fix itself validated its reviewed source INSIDE the record writer,
// which runs after the integration. Three instances at three verbs is not three
// mistakes; it is an unenforced rule. A fourth verb added tomorrow would be
// trusted to remember it. This module is what it consults instead.
//
// RETRY IS PART OF THE RULE, not a separate concern. An irreversible act that
// already happened must not happen twice: `alreadyPerformed` is consulted after
// validation and before the act, so a retry converges on the recorded effect
// rather than repeating it. That is the same shape COORD-691 gave the push
// (already_present) and COORD-706 gave the workspace merge (recovered receipt).

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// Runs `validations` in order, then `act` — never the other way round.
//
// `validations` are thunks. Each may throw; the first throw aborts BEFORE any
// outward call, which is the whole point: on that path the local topology and
// the remote are byte-for-byte unchanged because nothing outward was attempted.
//
// `alreadyPerformed` (optional) returns a previously recorded effect for this
// operation, or null. When it returns one, `act` is NOT called.
//
// `onEffect` (optional) is invoked with the act's result so the caller can
// journal the irreversible effect immediately — before whatever runs next can
// fail and roll the governed files back.
function performValidatedExternalEffect(spec = {}) {
  const { label, validations, act, alreadyPerformed, onEffect } = spec;
  if (typeof act !== "function") {
    throw new Error(`performValidatedExternalEffect(${label || "?"}) requires an \`act\` function.`);
  }

  const checks = asArray(validations);
  for (const check of checks) {
    if (typeof check !== "function") {
      throw new Error(
        `performValidatedExternalEffect(${label || "?"}) received a non-callable validation. ` +
        "Every validation must be a thunk so the ordering is observable, not implied."
      );
    }
    check();
  }

  if (typeof alreadyPerformed === "function") {
    const prior = alreadyPerformed();
    if (prior) {
      // The act already happened on an earlier attempt. Converging here is what
      // makes a retry safe: repeating an irreversible act is the failure this
      // rule exists to prevent, and it is not made safe by the act being
      // idempotent-looking.
      return { performed: false, recovered: prior, validations: checks.length };
    }
  }

  const result = act();
  if (typeof onEffect === "function") {
    onEffect(result);
  }
  return { performed: true, result, validations: checks.length };
}

module.exports = { performValidatedExternalEffect };
