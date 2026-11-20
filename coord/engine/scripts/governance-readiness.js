"use strict";

const { resolvePlanEvidence } = require("./plan-evidence-supersession.js");
const { projectIndependentReviews, resolveClaimedReviewScope, reviewOwnerOf } = require("./independent-reviews.js");

function createGovernanceReadiness(deps = {}) {
  const {
    normalizeGovernancePlanShape,
    resolveRepoCodeForTicket,
    isMeaningfulText,
    collectReviewPlanReadinessIssues,
    resolveTicketLightLane,
    requiresFeatureProofGovernance,
    isTestingInfrastructureTicket,
    collectTicketGovernanceIssueEvents,
    hasResolvedGovernanceRepairQuestion,
    fieldHasMeaningfulValue,
    deriveDecisionRequiredGuidance,
    repoNameForCode = (code) => (code === "X" ? "coord" : null),
  } = deps;

  // COORD-718: the claimed scope is the lock head, else the landed source
  // commit. Only the canonical plan-record ledger is read; question guidance
  // and self-review cycles never feed this projection.
  function safeRepositoryName(ticketId, row) {
    try {
      return repoNameForCode(resolveRepoCodeForTicket(ticketId, row));
    } catch {
      return null;
    }
  }

  function deriveIndependentReviewReadiness(ticketId, row, board, lock, planState) {
    // `lock` is this ticket's lock (findLockForTicket) or null.
    const scope = resolveClaimedReviewScope({
      lock,
      landing: board.landing_index?.[ticketId],
      repository: safeRepositoryName(ticketId, row),
      status: row.Status,
      reviewSubmission: planState?.review_submission,
    });
    return projectIndependentReviews(planState, { scope, owner: reviewOwnerOf(row.Owner) });
  }

  function deriveGovernanceReadiness(ticketId, row, board, lock, planState, questionsGuidance = null) {
    const governance = normalizeGovernancePlanShape(planState?.governance, resolveRepoCodeForTicket(ticketId, row));
    const startupChecklist = (planState?.startup_checklist || []).map((value) => String(value || "").trim().toLowerCase());
    const traceabilityGate = (planState?.traceability_gate || []).map((value) => String(value || "").trim().toLowerCase());
    const activeEvidence = resolvePlanEvidence(planState || {});
    const repoGates = activeEvidence.repo_gates;
    const featureProof = (planState?.feature_proof || []).filter((value) => isMeaningfulText(value) && !/^todo\b/i.test(String(value).trim()));
    const reviewIssues = collectReviewPlanReadinessIssues(ticketId, row);
    // COORD-166: surface the active plan-completeness lane (full vs light) in
    // explain output; actual relaxation stays in the readiness collectors.
    const laneDecision = resolveTicketLightLane(ticketId, row, planState);
    const selfReviewBlockedCodes = new Set([
      "self_review_cycle_count",
      "self_review_cycle_incomplete",
      "self_review_cycle_shallow",
      "self_review_lens_coverage",
      "self_review_final_verdict",
      // COORD-977: the reuse lens blocks the self-review cycle set like the others.
      "reuse_review_cycle",
      "reuse_review_cycle_shallow",
    ]);
    const selfReviewCyclesComplete = !reviewIssues.some((issue) => selfReviewBlockedCodes.has(issue.code));
    const featureProofRequired = requiresFeatureProofGovernance(board.metadata, ticketId, row) && !isTestingInfrastructureTicket(row, planState);
    const ticketRepairEvents = collectTicketGovernanceIssueEvents(ticketId)
      .filter((event) => ["recover", "manual-reconcile", "reconcile"].includes(String(event.command || "")));
    const hasResolvedQuestion = hasResolvedGovernanceRepairQuestion(ticketId);
    const ticketLocalRepairs = governance.ticket_local_repairs.length > 0
      ? governance.ticket_local_repairs
      : ticketRepairEvents.map((event) => ({
          kind: String(event.command),
          required_question_logged: hasResolvedQuestion,
          note: event.command === "manual-reconcile"
            ? "ticket-local governance reconcile affected this ticket's closeout path"
            : "ticket-local governance repair was required before lifecycle could proceed",
        }));
    const repairQuestionLogged = ticketLocalRepairs.length === 0 || hasResolvedQuestion;
    return {
      active_lane: {
        lane: laneDecision.eligible ? "light" : "full",
        light_lane_eligible: laneDecision.eligible,
        reason: laneDecision.reason,
      },
      bootstrap: {
        startup_attested: startupChecklist.includes("completed"),
        traceability_status: traceabilityGate.find((value) => ["verified", "closing-gap", "exempt"].includes(value)) || "pending",
      },
      review_prep: {
        repo_gates_recorded:
          fieldHasMeaningfulValue(repoGates) ||
          repoGates.some((value) => String(value).trim().toLowerCase() === "not-required"),
        feature_proof_recorded: featureProofRequired ? featureProof.length > 0 : true,
        self_review_cycles_complete: selfReviewCyclesComplete,
      },
      current_plan_evidence: {
        repo_gates: activeEvidence.current_entries.repo_gates,
        verification_commands: activeEvidence.current_entries.verification_commands,
        superseded_history: activeEvidence.history,
      },
      closeout: {
        expected_method: governance.expected_closeout.method,
        base_ref: governance.expected_closeout.base_ref,
        provenance_note: governance.expected_closeout.provenance_note,
        repair_ticket_local: ticketLocalRepairs.length > 0,
        repair_question_logged: repairQuestionLogged,
      },
      decision_required: deriveDecisionRequiredGuidance(ticketId, row, planState),
      independent_reviews: deriveIndependentReviewReadiness(ticketId, row, board, lock, planState),
      ticket_local_repairs: ticketLocalRepairs,
    };
  }

  return { deriveGovernanceReadiness };
}

module.exports = { createGovernanceReadiness };
