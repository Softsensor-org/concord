"use strict";

// COORD-691 round 1 review, finding 2 — the shared external-side-effect
// recorder.
//
// WHY IT MOVED HERE. `recordGovernanceExternalSideEffect` lived inside the
// journal FACTORY, which is instantiated once in coord/scripts/lifecycle.js and
// reachable only through that injection graph. control-plane-landing.js is
// required directly by closeout.js, so it had no way to call it — and so a
// governed push that had already advanced a real remote was recorded NOWHERE
// durable: the receipt reached only the in-memory board, and a later failure in
// cleanup or mark-done rolled the board back and took the receipt with it. The
// push stayed. The retry then saw ancestry already satisfied, skipped the push,
// and recorded no receipt at all — with the suite reading that absence as
// "no push occurred".
//
// The recorder is a pure function of the shared `state` singleton (the same
// singleton governance-board-state.js already reads), so hoisting it out of the
// factory changes nothing about its behaviour and requires no new wiring in the
// composition root — which matters, because coord/scripts/lifecycle.js is held
// to an EXACT line budget by the decomposition proof gate.
//
// journal.js re-exports this function rather than defining its own, so there is
// one implementation and one meaning of "an irreversible thing happened".

const { state } = require("./governance-context.js");

function recordGovernanceExternalSideEffect(effect) {
  if (!state.activeGovernanceMutationContext || !effect || typeof effect !== "object") {
    return { recorded: false };
  }
  state.activeGovernanceMutationContext.externalSideEffects.push({
    ...effect,
    recorded_at: new Date().toISOString(),
  });
  return { recorded: true };
}

// True when a governed mutation is in progress. A caller about to do something
// irreversible uses this to tell "my effect will be preserved" from "nothing is
// listening", instead of assuming the former.
function inGovernanceMutation() {
  return Boolean(state.activeGovernanceMutationContext);
}

module.exports = { recordGovernanceExternalSideEffect, inGovernanceMutation };
