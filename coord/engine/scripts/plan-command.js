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
const { selectPlanUpdateOptions } = require("./plan-update-options.js");
const { stableIdempotencyKey } = require("./idempotency.js");
const { assertContextPackAckWriteReady } = require("./context-pack-ack-contract.js");
const approvalVerifier = require("./approval-verifier.js");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const { resolveEntrySelector, isIdenticalCorrection } = require(resolveEngineModule(
  path.resolve(__dirname, "..", ".."),
  "scripts/plan-evidence-supersession.js",
));
const createIndependentReviewCommand = require("./independent-review-command.js");
const createManagedEvidenceCommand = require("./managed-evidence-command.js");
// COORD-718: pure helper taken directly (the composition root no longer
// re-wraps it); `fail` likewise defaults to the shared defaultFail thunk.
const { toArray: pureToArray } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-utils.js"));

module.exports = function createPlanCommand(deps = {}) {
  const fail = deps.fail || defaultFail;
  const {
    toArray = pureToArray,
    isDoingStatus,
    readBoard,
    getTicketRef,
    readPlanState,
    updateCanonicalPlanState,
    collectStartReadinessBlockers,
    collectStartReadinessAdvisories,
    collectReviewPlanReadinessIssues,
    withGovernanceMutation,
    inferTicketStatus,
    ensureCurrentAgentIdentity,
    ensureTicketMutationOwnership,
    resolveHumanAdminOverride,
    appendGovernanceEvent,
    runtimeDir,
    defaultStartTraceabilityValue,
    ticketRequiresBaseline,
  } = deps;
  // COORD-718: the independent-review writer shares this factory's governed
  // plan-writer and identity collaborators; it takes no ownership gate.
  const { recordIndependentReviewCommand } = createIndependentReviewCommand({ ...deps, fail });
  // COORD-860: the managed-execution evidence writer shares the same collaborators.
  const { recordManagedEvidenceCommand } = createManagedEvidenceCommand({ ...deps, fail });

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
    return selectPlanUpdateOptions(options);
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
      "adrRef",
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
    const startAdvisories = typeof collectStartReadinessAdvisories === "function"
      ? collectStartReadinessAdvisories(ticketId, ref.row, board)
      : [];
    const reviewIssues = collectReviewPlanReadinessIssues(ticketId, ref.row);
    return {
      ticket: ticketId,
      plan_exists: Boolean(planState),
      plan: planState,
      start_readiness: {
        ready: startBlockers.length === 0,
        blockers: startBlockers,
        advisories: startAdvisories,
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

  function updatePlanBlock(ticketId, options, renderResult) {
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
      // COORD-557: an explicit not-applicable disposition is auditable from the
      // journal event itself, not only from the record it leaves behind.
      if (options.contextPackAckDisposition) mutation.details = { context_pack_ack: options.contextPackAckDisposition };
      const result = updateCanonicalPlanState(ticketId, options);
      assertContextPackAckWriteReady(ticketId, options, { fail, readBoard, getTicketRef, collectReviewPlanReadinessIssues });
      if (typeof renderResult === "function") {
        renderResult(result);
      } else {
        console.log(`Updated plan state for ${ticketId}.`);
      }
      return result;
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
    if (options.replace !== true) {
      fail("set-review-cycles replaces the complete review-cycle collection; pass --replace to confirm, or use add-review-cycle for incremental evidence.");
    }
    const reviewCycles = toArray(options.reviewCycle).map((value) => String(value || "").trim()).filter(Boolean);
    if (reviewCycles.length === 0) {
      fail('set-review-cycles requires at least one --review-cycle "lens=...; diff=...; risks=...; findings=...; verification=...; verdict=...".');
    }
    return updatePlanBlock(ticketId, {
      replaceAllReviewCycles: true,
      reviewCycle: reviewCycles,
    }, ({ record }) => {
      console.log(JSON.stringify({
        status: "updated",
        ticket: ticketId,
        self_review_cycles: record.self_review_cycles,
      }, null, 2));
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
      // --supersede REPLACES the prior requirement_closure block instead of
      // appending (COORD-198). requirement_closure is append-only by default, so a
      // re-closure (e.g. partial -> complete after a takeover) otherwise leaves
      // BOTH the old and new blocks in the ordered array. The derived verdict/debt
      // read uses recency (last block wins) so the contradiction is harmless, but
      // --supersede keeps the record clean for future re-closures.
      ...(options.supersede ? { replaceClosure: true } : {}),
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

  function supersedePlanEvidenceCommand(ticketId, options = {}) {
    if (!ticketId) fail("supersede-plan-evidence requires <ticket-id>.");
    if (options.disposition !== undefined) {
      if (options.kind !== "critical_invariant" || options.disposition !== "retracted" || !options.entry || !options.reason || options.replacement) {
        fail("supersede-plan-evidence disposition requires --kind critical_invariant, --entry, --disposition retracted, and --reason, without --replacement.");
      }
      const plan = readPlanState(ticketId);
      if (!plan) fail(`supersede-plan-evidence requires an existing plan record for ${ticketId}.`);
      let source;
      try { source = resolveEntrySelector(plan, options.kind, options.entry, { allowRetracted: true }); }
      catch (error) { fail(error.message); }
      const identityIntent = { kind: options.kind, source_ref: source.ref, disposition: options.disposition, reason: String(options.reason).trim() };
      // COORD-822: an identical replay is a no-op decided from the plan record,
      // before any governed mutation opens, so it never appends a journal row.
      if (isIdenticalCorrection(plan, { kind: options.kind, sourceRef: source.ref, disposition: options.disposition, reason: options.reason })) return undefined;
      const mutation = {
        command: "supersede-plan-evidence",
        ticket: ticketId,
        beforeStatus: inferTicketStatus(ticketId),
        idempotencyKey: stableIdempotencyKey("retract-plan-invariant", ticketId, identityIntent),
      };
      return withGovernanceMutation(mutation, () => {
        mutation.identity = assertTicketPlanMutationAuthority(ticketId, options);
        const actor = String(mutation.identity?.agent?.handle || "").trim();
        if (!actor) fail("supersede-plan-evidence could not resolve a registered acting agent.");
        let result;
        try {
          result = updateCanonicalPlanState(ticketId, { evidenceDisposition: {
            kind: options.kind, entry: source.ref, disposition: options.disposition, reason: options.reason, actor,
          } });
        } catch (error) { fail(error.message); }
        const relation = (result.record.evidence_dispositions || []).find((item) => item.source_ref === source.ref);
        if (!relation) fail("canonical plan writer did not preserve the requested invariant disposition.");
        mutation.details = { evidence_kind: options.kind, source_selector: options.entry, disposition_id: relation.id, disposition: relation.disposition };
        console.log(JSON.stringify({ status: "updated", ticket: ticketId, disposition: relation }, null, 2));
        return result;
      });
    }
    if (!options.kind || !options.entry || !options.replacement || !options.reason) {
      fail("supersede-plan-evidence requires --kind <repo_gate|verification_command|critical_invariant>, --entry <stable-ref|exact-value>, --replacement <value>, and --reason <text>, or a critical-invariant --disposition retracted.");
    }
    const plan = readPlanState(ticketId);
    if (!plan) fail(`supersede-plan-evidence requires an existing plan record for ${ticketId}.`);
    let source;
    try {
      source = resolveEntrySelector(plan, options.kind, options.entry, { allowSuperseded: true });
    } catch (error) {
      fail(error.message);
    }
    if (isIdenticalCorrection(plan, { kind: options.kind, sourceRef: source.ref, replacement: options.replacement, reason: options.reason })) {
      return undefined;
    }
    const identityIntent = {
      kind: options.kind,
      source_ref: source.ref,
      replacement: String(options.replacement).trim(),
      reason: String(options.reason).trim(),
    };
    const mutation = {
      command: "supersede-plan-evidence",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("supersede-plan-evidence", ticketId, identityIntent),
    };
    return withGovernanceMutation(mutation, () => {
      mutation.identity = assertTicketPlanMutationAuthority(ticketId, options);
      const actor = String(mutation.identity?.agent?.handle || "").trim();
      if (!actor) fail("supersede-plan-evidence could not resolve a registered acting agent.");
      let result;
      try {
        result = updateCanonicalPlanState(ticketId, {
          evidenceSupersession: {
            kind: options.kind,
            entry: source.ref,
            replacement: options.replacement,
            reason: options.reason,
            actor,
          },
        });
      } catch (error) {
        fail(error.message);
      }
      const relation = (result.record.evidence_supersessions || []).find((item) => item.source_ref === source.ref);
      if (!relation) fail("canonical plan writer did not preserve the requested evidence supersession.");
      mutation.details = {
        evidence_kind: options.kind,
        source_selector: options.entry,
        supersession_id: relation.id,
        replacement_recorded: true,
      };
      console.log(`Superseded ${options.kind} evidence for ${ticketId}; source remains in historical plan evidence.`);
      return result;
    });
  }

  // guard:bound-owner
  function assertTicketPlanMutationAuthority(ticketId, options = {}) {
    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      return null;
    }
    if (options.humanAdminOverride !== undefined) {
      approvalVerifier.requireSignedOverride({
        commandName: "plan mutation",
        ticketId,
        row: {
          ticket: ref.row,
          plan: readPlanState(ticketId) || null,
          updates: selectPlanUpdateOptions(options),
        },
        options,
        deps: { resolveHumanAdminOverride, fail, appendGovernanceEvent, runtimeDir },
      });
      return ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
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
    supersedePlanEvidenceCommand,
    recordIndependentReviewCommand,
    recordManagedEvidenceCommand,
    assertTicketPlanMutationAuthority,
  };
};
