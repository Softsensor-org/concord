"use strict";

// COORD-680: shared construction-time dependency validation for the lifecycle
// factories.
//
// WHY THIS EXISTS. The lifecycle factories take everything by injection. A
// helper omitted from an injection object (or appended as a bare shorthand that
// resolved to `undefined`) used to survive wiring and only explode later, at the
// call site of whichever verb reached it first — `gov resume` threw
// `TypeError: ensureGovernedWorkspaceForTicket is not a function` AFTER it had
// already rebound the ticket lock, presenting a wiring defect as a partially
// applied governed mutation. Validating at construction turns that into a clear
// refusal before any verb runs.
//
// WHY IT IS SHARED RATHER THAN COPIED. The check first landed inside
// agent-commands.js, which left every SIBLING factory unvalidated —
// createTicketTransitions owns `startTicket` / `returnDoing` and had no check at
// all, so the identical defect could reappear one module over. A copy in each
// factory would drift; this module is the single definition both consume.
//
// TYPED, NOT MERELY SHAPED, AND NOT CONDITIONAL. The thrown error must be a
// GovernanceError: cli.js formats only GovernanceError instances and rethrows
// everything else, so a plain Error carrying the right `code` still reaches the
// operator as a raw stack trace.
//
// GovernanceError is IMPORTED here rather than injected. An earlier revision
// took it from `deps`/options and fell back to the built-in Error when it was
// absent — which made the typed guarantee conditional on wiring, and the test
// helper always injected it, so the fallback was never exercised. A guarantee
// with an unexercised escape hatch is not a guarantee. Importing it removes the
// branch entirely: there is no wiring under which this throws an untyped error.
// governance-context.js requires neither this module nor agent-commands.js, so
// the import introduces no cycle.

const { GovernanceError } = require("./governance-context.js");

// CLASSIFIED, NOT INFERRED. An earlier revision derived requiredness from
// direct `name(...)` call sites. That is blind to every other way a dependency
// is consumed, and two escaped: `appendReviewFollowupPlan` is passed as a
// REFERENCE (`appendPlan: appendReviewFollowupPlan`) and invoked later, and
// `GovernanceError` is used as the right-hand side of `instanceof`. Both
// survived construction and would fail at their use site — the AMNL-009 class
// the ticket exists to remove, with `instanceof` producing a raw
// `TypeError: Right-hand side of 'instanceof' is not an object`.
//
// So each factory declares an EXHAUSTIVE contract instead:
//   callable — must be `typeof === "function"` (helpers and callbacks)
//   value    — must merely be present (constants, registries, state objects)
//
// An `instanceof` operand is deliberately NOT a third class and does not belong
// under `callable`: `typeof === "function"` is satisfied by an arrow function,
// which has no prototype and so still throws
// `TypeError: Right-hand side of 'instanceof' is not an object` at the use site.
// Classifying such a dependency as callable would therefore report coverage this
// check cannot deliver. The house rule is to IMPORT it (as this module imports
// GovernanceError) rather than inject it, which removes the wiring question
// instead of validating it weakly.
// A name that is destructured but classified in neither is UNCLASSIFIED, and
// the accompanying test rejects that. Adding a dependency therefore forces a
// classification decision rather than silently defaulting to unvalidated.

function assertFactoryDependencies(factoryName, deps = {}, contract = []) {
  const normalized = Array.isArray(contract)
    ? { callable: contract, value: [] }
    : { callable: contract.callable || [], value: contract.value || [] };

  const missingCallable = normalized.callable.filter((name) => typeof deps[name] !== "function");
  const missingValue = normalized.value.filter(
    (name) => deps[name] === undefined || deps[name] === null,
  );
  const missing = [...missingCallable, ...missingValue];
  if (missing.length === 0) {
    return;
  }

  // COORD-680 round 5: the remediation must match the CLASSIFICATION. A single
  // callable-only message told an operator that a missing `STATUS` "must be
  // injected as a callable" and that "only callability is required" — wrong
  // advice for a value collaborator, and a failure of the actionable-hint
  // requirement. Each class now gets its own sentence, and only the classes that
  // actually failed are mentioned.
  //
  // Round 6: this block is PINNED BY TEST. It had been verified only by a manual
  // probe, and deleting it outright left all 23 focused tests passing —
  // unprotected behaviour that read as covered. The "only callability is
  // required" wording is corrected below too: callability is what this check
  // enforces, but it is NOT sufficient for an `instanceof` operand, and that
  // overstatement is what made the arrow-function hole look acceptable.
  const remediation = [];
  if (missingCallable.length > 0) {
    remediation.push(
      `Callable dependencies (must be typeof "function"): ${missingCallable.join(", ")}. ` +
      "A deferred `(...args) => fn(...args)` wrapper is the house style for helpers " +
      "defined later in the composition root, but bare shorthand is correct for " +
      "hoisted function declarations. NOTE: callability is what THIS check " +
      "enforces, and it is not sufficient for every use — a dependency used as " +
      "an `instanceof` right-hand side additionally needs a prototype, which an " +
      "arrow function does not have. Such a dependency should be imported rather " +
      "than injected (see GovernanceError), not classified here."
    );
  }
  if (missingValue.length > 0) {
    remediation.push(
      `Value dependencies (must be PRESENT, and are NOT required to be callable): ` +
      `${missingValue.join(", ")}. These are constants, registries or state objects — ` +
      "inject the object itself; wrapping one in a function is wrong and will not " +
      "satisfy this check."
    );
  }

  const error = new GovernanceError(
    `${factoryName} is missing required dependencies: ${missing.join(", ")}. ` +
    "This is a governance engine wiring defect, not an operator error. " +
    remediation.join(" ")
  );
  error.missing_callable = missingCallable;
  error.missing_value = missingValue;
  error.code = "governance_factory_dependency_missing";
  error.factory = factoryName;
  error.missing = missing;
  throw error;
}

module.exports = { assertFactoryDependencies };
