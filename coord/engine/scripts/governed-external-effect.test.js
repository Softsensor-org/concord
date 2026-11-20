"use strict";

// COORD-703: the ordering rule itself.
//
// Three verbs have broken "validate before you act" independently — `submit`
// (COORD-697), `land` (this ticket, measured on CONS-025 where PR #12 was
// squash-merged and the landing then failed provenance validation and rolled the
// governed files back), and the COORD-706 fix, whose own source validation ran
// inside a writer that executes after the integration. Three instances at three
// verbs is an unenforced rule, so the rule now has one implementation and this
// file is what pins it.

const test = require("node:test");
const assert = require("node:assert/strict");

const { performValidatedExternalEffect } = require("./governed-external-effect.js");

test("COORD-703: every validation runs BEFORE the act", () => {
  const order = [];
  const out = performValidatedExternalEffect({
    label: "probe",
    validations: [() => order.push("check-1"), () => order.push("check-2")],
    act: () => { order.push("act"); return "merged"; },
  });
  assert.deepEqual(order, ["check-1", "check-2", "act"]);
  assert.equal(out.performed, true);
  assert.equal(out.result, "merged");
});

test("COORD-703 RED: a failing validation means the act NEVER runs", () => {
  const order = [];
  assert.throws(
    () => performValidatedExternalEffect({
      label: "probe",
      validations: [
        () => order.push("check-1"),
        () => { order.push("check-2"); throw new Error("provenance is not resolvable"); },
        () => order.push("check-3"),
      ],
      act: () => { order.push("act"); },
    }),
    /provenance is not resolvable/,
  );
  // The act is absent AND the later validation never ran: the first refusal
  // stops everything, so nothing outward is attempted and local topology and
  // remote state are untouched by construction.
  assert.deepEqual(order, ["check-1", "check-2"]);
});

test("COORD-703: an already-performed effect is NOT repeated", () => {
  const order = [];
  const out = performValidatedExternalEffect({
    label: "probe",
    validations: [() => order.push("check")],
    alreadyPerformed: () => ({ mergeCommitSha: "abc123", recovered: true }),
    act: () => { order.push("act"); },
  });
  assert.deepEqual(order, ["check"], "the act must not run when the effect is already recorded");
  assert.equal(out.performed, false);
  assert.equal(out.recovered.mergeCommitSha, "abc123");
});

test("COORD-703: the retry check runs AFTER validation, not instead of it", () => {
  const order = [];
  assert.throws(
    () => performValidatedExternalEffect({
      label: "probe",
      validations: [() => { order.push("check"); throw new Error("still has open review findings"); }],
      alreadyPerformed: () => { order.push("already"); return { recovered: true }; },
      act: () => order.push("act"),
    }),
    /open review findings/,
  );
  // A prior effect does not excuse a ticket from its checks: an invalid closeout
  // stays invalid whether or not the irreversible half already happened.
  assert.deepEqual(order, ["check"]);
});

test("COORD-703: the irreversible effect is handed to the recorder before anything else can fail", () => {
  const order = [];
  const recorded = [];
  performValidatedExternalEffect({
    label: "probe",
    validations: [() => order.push("check")],
    act: () => { order.push("act"); return { mergeCommitSha: "deadbeef" }; },
    onEffect: (result) => { order.push("record"); recorded.push(result); },
  });
  assert.deepEqual(order, ["check", "act", "record"]);
  assert.deepEqual(recorded, [{ mergeCommitSha: "deadbeef" }]);
});

test("COORD-703: a non-callable validation is refused rather than skipped", () => {
  // A validation that is not a thunk cannot be observed to run, and silently
  // skipping it would make the ordering guarantee unfalsifiable.
  assert.throws(
    () => performValidatedExternalEffect({ label: "probe", validations: ["not-a-function"], act: () => {} }),
    /non-callable validation/,
  );
  assert.throws(
    () => performValidatedExternalEffect({ label: "probe", validations: [] }),
    /requires an `act` function/,
  );
});
