"use strict";

// COORD-691 round 1 review, finding 2 — the shared external-side-effect
// recorder.
//
// WHY IT MOVED HERE. `recordGovernanceExternalSideEffect` lived inside the
// journal FACTORY, which is instantiated once in coord/engine/scripts/lifecycle.js and
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
// composition root — which matters, because coord/engine/scripts/lifecycle.js is held
// to an EXACT line budget by the decomposition proof gate.
//
// journal.js re-exports this function rather than defining its own, so there is
// one implementation and one meaning of "an irreversible thing happened".

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveEngineModule } = require("../../paths.js");
const COORD_DIR = path.resolve(__dirname, "..", "..");
const { state } = require(resolveEngineModule(COORD_DIR, "scripts/governance-context.js"));

// COORD-950: an effect is persisted the moment it is recorded, not when the
// mutation ends. Before this, the record lived only in the in-memory context
// array, so a SIGKILL after a PR or workspace merge left the merge done with no
// trace in the journal (withGovernanceMutation journals the array only on
// completion). Each effect is appended, fsynced and identified here; crash
// recovery (journal.js recoverCrashedGovernanceMutation) journals any persisted
// effect that the journal does not already carry, matched by effect_id.
function pendingExternalEffectsPath() {
  return path.join(state.RUNTIME_DIR, "governance-external-effects.ndjson");
}

function recordGovernanceExternalSideEffect(effect) {
  if (!state.activeGovernanceMutationContext || !effect || typeof effect !== "object") {
    return { recorded: false };
  }
  const entry = {
    ...effect,
    recorded_at: new Date().toISOString(),
  };
  entry.effect_id = crypto.createHash("sha256").update(JSON.stringify(entry)).digest("hex").slice(0, 32);
  state.activeGovernanceMutationContext.externalSideEffects.push(entry);
  fs.mkdirSync(state.RUNTIME_DIR, { recursive: true });
  const fd = fs.openSync(pendingExternalEffectsPath(), "a");
  try {
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`, null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // kill-point:external-effect-recorded
  crashPoint("external-effect-recorded", { type: effect.type || null });
  return { recorded: true };
}

// Effects persisted by mutations. A torn trailing line is a record that never
// completed; the external action it describes is then unrecoverable from this
// file alone and is reported by the caller's own evidence, not invented here.
function readPendingGovernanceExternalSideEffects() {
  let text;
  try {
    text = fs.readFileSync(pendingExternalEffectsPath(), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const effects = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      effects.push(JSON.parse(line));
    } catch {
      // torn trailing record: see above
    }
  }
  return effects;
}

function clearPendingGovernanceExternalSideEffects() {
  fs.rmSync(pendingExternalEffectsPath(), { force: true });
}

// Persisted effects the journal does not carry yet, matched by effect_id.
function unjournaledPendingGovernanceExternalSideEffects(journaledEvents) {
  const journaled = new Set();
  for (const event of journaledEvents) {
    for (const effect of event?.details?.external_side_effects || []) if (effect?.effect_id) journaled.add(effect.effect_id);
  }
  return readPendingGovernanceExternalSideEffects().filter((effect) => !effect.effect_id || !journaled.has(effect.effect_id));
}

// True when a governed mutation is in progress. A caller about to do something
// irreversible uses this to tell "my effect will be preserved" from "nothing is
// listening", instead of assuming the former.
function inGovernanceMutation() {
  return Boolean(state.activeGovernanceMutationContext);
}

// COORD-950: named kill windows for the real-process crash harness
// (crash-window-child.js). crashPoint() is a no-op unless a test installs a hook
// with setCrashPointHook(); the hook may block so the parent can SIGKILL the
// process at exactly that point. Production never installs one.
let crashPointHook = null;
function setCrashPointHook(hook) {
  crashPointHook = typeof hook === "function" ? hook : null;
}
function crashPoint(name, context = {}) {
  if (crashPointHook) crashPointHook(name, context);
}

module.exports = {
  recordGovernanceExternalSideEffect,
  inGovernanceMutation,
  readPendingGovernanceExternalSideEffects,
  unjournaledPendingGovernanceExternalSideEffects,
  clearPendingGovernanceExternalSideEffects,
  setCrashPointHook,
  crashPoint,
};
