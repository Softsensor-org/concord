"use strict";

// Wave 2 (COORD-060): plan-command surface extracted from lifecycle.js — the
// `gov plan`/`gov update-plan` commands plus the plan-block mutation verbs
// (review cycles, requirement closure, feature proofs), the plan-command option
// parsing/merge helpers, the start-seed builder, the plan status/next-command
// payload builders, and the plan-mutation authority gate. DI-factory; canonical
// plan-state read/write lives in plan-records.js and is injected, as are
// board/identity/journal/validation helpers from their owning modules.
// Wave 3 (COORD-069): the repo-gate ATTRIBUTION / board-record surface
// (add-repo-gate verb + classifier + entry formatter) was extracted to gates.js;
// updatePlanBlock is injected back into that module so gate entries still land in
// canonical plan state.

const { defaultFail } = require("./governance-context.js");
const { STATUS } = require("./governance-constants.js");

module.exports = function createPlanCommand(deps = {}) {
  const fail = deps.fail || defaultFail;
  const {
    toArray,
    isDoingStatus,
    readBoard,
    getTicketRef,
    readPlanState,
    updateCanonicalPlanState,
    collectStartReadinessBlockers,
    collectReviewPlanReadinessIssues,
    withGovernanceMutation,
    inferTicketStatus,
    ensureCurrentAgentIdentity,
    ensureTicketMutationOwnership,
    resolveHumanAdminOverride,
    defaultStartTraceabilityValue,
    ticketRequiresBaseline,
  } = deps;

  function buildStartPlanSeedUpdate(row) {
    const update = {
      startup: "completed",
      traceability: defaultStartTraceabilityValue(row),
    };
    if (ticketRequiresBaseline(row)) {
      update.baseline = [
        "Command: <repro command>",
        "Outcome: <observed result>",
      ];
    }
    return update;
  }

  function planCommandUpdateOptions(options = {}) {
    const update = {};
    for (const key of [
      "summary",
      "verify",
      "files",
      "dropFile",
      "security",
      "startup",
      "traceability",
      "baseline",
      "invariant",
      "closure",
      "featureProof",
      "dropFeatureProof",
      "repoGate",
      "rollback",
      "closeoutMethod",
      "closeoutBaseRef",
      "provenanceNote",
      "reviewProfile",
      "reviewCycle",
      "replaceReviewCycle",
      "dropReviewCycle",
      "replaceAllReviewCycles",
    ]) {
      if (options[key] !== undefined) {
        update[key] = options[key];
      }
    }
    return update;
  }

  function mergePlanCommandOptions(seedOptions = {}, updateOptions = {}) {
    const merged = { ...seedOptions, ...updateOptions };
    for (const key of [
      "verify",
      "files",
      "dropFile",
      "baseline",
      "invariant",
      "closure",
      "featureProof",
      "dropFeatureProof",
      "repoGate",
      "rollback",
      "reviewCycle",
    ]) {
      const values = [
        ...toArray(seedOptions[key]),
        ...toArray(updateOptions[key]),
      ].filter((value) => value !== undefined && value !== null && String(value).trim());
      if (values.length > 0) {
        merged[key] = values;
      } else {
        delete merged[key];
      }
    }
    return merged;
  }

  function hasPlanCommandUpdates(options = {}) {
    return Object.keys(planCommandUpdateOptions(options)).length > 0;
  }

  function buildPlanNextCommands(ticketId, row, planState, context = {}) {
    const commands = [];
    if (!planState) {
      commands.push(`coord/scripts/gov plan ${ticketId} --seed`);
    }
    const startBlockers = context.startBlockers || [];
    if (row.Status === STATUS.TODO || row.Status === STATUS.DEFERRED) {
      for (const blocker of startBlockers) {
        for (const step of blocker.next_steps || []) {
          if (!commands.includes(step)) {
            commands.push(step);
          }
        }
      }
      if (startBlockers.length === 0) {
        commands.push(`coord/scripts/gov start ${ticketId}`);
      }
      return commands;
    }
    const reviewIssues = context.reviewIssues || [];
    if (isDoingStatus(row.Status) && reviewIssues.length > 0) {
      for (const issue of reviewIssues) {
        for (const step of issue.next_steps || []) {
          if (!commands.includes(step)) {
            commands.push(step);
          }
        }
      }
      return commands;
    }
    return commands;
  }

  function buildPlanStatusPayload(ticketId) {
    if (!ticketId) {
      fail("plan requires <ticket-id>.");
    }
    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    const planState = readPlanState(ticketId);
    const startBlockers = collectStartReadinessBlockers(ticketId, ref.row, board);
    const reviewIssues = collectReviewPlanReadinessIssues(ticketId, ref.row);
    return {
      ticket: ticketId,
      plan_exists: Boolean(planState),
      plan: planState,
      start_readiness: {
        ready: startBlockers.length === 0,
        blockers: startBlockers,
      },
      review_readiness: {
        ready: reviewIssues.length === 0,
        blockers: reviewIssues,
      },
      next_commands: buildPlanNextCommands(ticketId, ref.row, planState, {
        startBlockers,
        reviewIssues,
      }),
    };
  }

  function planTicket(ticketId, options = {}) {
    if (!ticketId) {
      fail("plan requires <ticket-id>.");
    }
    if (options.seed || hasPlanCommandUpdates(options)) {
      const mutation = {
        command: "plan",
        ticket: ticketId,
        beforeStatus: inferTicketStatus(ticketId),
      };
      return withGovernanceMutation(mutation, () => {
        const board = readBoard();
        const ref = getTicketRef(board, ticketId);
        if (!ref) {
          fail(`Unknown ticket "${ticketId}".`);
        }
        const updateOptions = planCommandUpdateOptions(options);
        const seedOptions = options.seed ? buildStartPlanSeedUpdate(ref.row) : {};
        const update = mergePlanCommandOptions(seedOptions, updateOptions);
        const result = updateCanonicalPlanState(ticketId, update);
        const payload = {
          status: "updated",
          ticket: ticketId,
          source: result.source,
          plan: result.record,
          next_commands: buildPlanNextCommands(ticketId, ref.row, result.record, {
            startBlockers: collectStartReadinessBlockers(ticketId, ref.row, board),
            reviewIssues: collectReviewPlanReadinessIssues(ticketId, ref.row),
          }),
        };
        console.log(JSON.stringify(payload, null, 2));
      });
    }
    console.log(JSON.stringify(buildPlanStatusPayload(ticketId), null, 2));
  }

  function updatePlanBlock(ticketId, options) {
    const mutation = {
      command: "update-plan",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("update-plan requires <ticket-id>.");
      }
      mutation.identity = assertTicketPlanMutationAuthority(ticketId, options);
      updateCanonicalPlanState(ticketId, options);
      console.log(`Updated plan state for ${ticketId}.`);
    });
  }

  function addReviewCycleCommand(ticketId, options = {}) {
    if (!ticketId) {
      fail("add-review-cycle requires <ticket-id>.");
    }
    if (!options.lens || !options.diff || !options.findings || !options.verification || !options.verdict) {
      fail("add-review-cycle requires --lens, --diff, --findings, --verification, and --verdict.");
    }
    const risks = toArray(options.risk).map((value) => String(value || "").trim()).filter(Boolean);
    if (risks.length < 2) {
      fail("add-review-cycle requires at least 2 --risk values.");
    }
    const cycle = [
      `lens=${options.lens}`,
      `diff=${options.diff}`,
      `risks=${risks.join(", ")}`,
      `findings=${options.findings}`,
      `verification=${options.verification}`,
      `verdict=${options.verdict}`,
    ].join("; ");
    return updatePlanBlock(ticketId, {
      reviewCycle: [cycle],
      ...(typeof options.replaceReviewCycle === "number" ? { replaceReviewCycle: options.replaceReviewCycle } : {}),
    });
  }

  function setReviewCyclesCommand(ticketId, options = {}) {
    if (!ticketId) {
      fail("set-review-cycles requires <ticket-id>.");
    }
    const reviewCycles = toArray(options.reviewCycle).map((value) => String(value || "").trim()).filter(Boolean);
    if (reviewCycles.length === 0) {
      fail('set-review-cycles requires at least one --review-cycle "lens=...; diff=...; risks=...; findings=...; verification=...; verdict=...".');
    }
    return updatePlanBlock(ticketId, {
      replaceAllReviewCycles: true,
      reviewCycle: reviewCycles,
    });
  }

  function setRequirementClosureCommand(ticketId, options = {}) {
    if (!ticketId) {
      fail("set-requirement-closure requires <ticket-id>.");
    }
    if (!options.ticketAsk || !options.implemented || !options.closeoutVerdict) {
      fail("set-requirement-closure requires --ticket-ask, --implemented, and --closeout-verdict.");
    }
    return updatePlanBlock(ticketId, {
      closure: [
        `Ticket ask: ${options.ticketAsk}`,
        `Implemented: ${options.implemented}`,
        `Not implemented: ${options.notImplemented || "none"}`,
        `Deferred to: ${options.deferredTo || "none"}`,
        `Closeout verdict: ${options.closeoutVerdict}`,
      ],
    });
  }

  function addFeatureProofCommand(ticketId, options = {}) {
    if (!ticketId) {
      fail("add-feature-proof requires <ticket-id>.");
    }
    const proofs = buildFeatureProofEntriesFromOptions(options);
    if (proofs.length !== 1) {
      fail("add-feature-proof requires exactly one of --proof-path, --proof-symbol, --proof-text, or --proof-route.");
    }
    return updatePlanBlock(ticketId, {
      featureProof: proofs,
    });
  }

  function buildFeatureProofEntriesFromOptions(options = {}) {
    return [
      options.proofPath ? `path:${options.proofPath}` : null,
      options.proofSymbol ? `symbol:${options.proofSymbol}` : null,
      options.proofText ? `text:${options.proofText}` : null,
      options.proofRoute ? `route:${options.proofRoute}` : null,
    ].filter(Boolean);
  }

  function dropFeatureProofCommand(ticketId, options = {}) {
    if (!ticketId) {
      fail("drop-feature-proof requires <ticket-id>.");
    }
    const proofs = buildFeatureProofEntriesFromOptions(options);
    if (proofs.length !== 1) {
      fail("drop-feature-proof requires exactly one of --proof-path, --proof-symbol, --proof-text, or --proof-route.");
    }
    return updatePlanBlock(ticketId, {
      dropFeatureProof: proofs,
    });
  }

  function assertTicketPlanMutationAuthority(ticketId, options = {}) {
    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      return null;
    }
    if (options.humanAdminOverride) {
      resolveHumanAdminOverride("plan mutation", options, { allowLegacyForce: false });
      return null;
    }
    if (!ref.row.Owner || ref.row.Owner === "unassigned") {
      return ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    }
    return ensureTicketMutationOwnership(ticketId, ref.row, null, options);
  }

  return {
    buildStartPlanSeedUpdate,
    planCommandUpdateOptions,
    mergePlanCommandOptions,
    hasPlanCommandUpdates,
    buildPlanNextCommands,
    buildPlanStatusPayload,
    planTicket,
    updatePlanBlock,
    addReviewCycleCommand,
    setReviewCyclesCommand,
    setRequirementClosureCommand,
    addFeatureProofCommand,
    buildFeatureProofEntriesFromOptions,
    dropFeatureProofCommand,
    assertTicketPlanMutationAuthority,
  };
};
