"use strict";

const path = require("path");
const { supervisionReport } = require("../runtime-authority.js");

function createReviewCloseoutGate(deps) {
  const {
    coordDir,
    effectiveTierMinimum,
    fieldHasMeaningfulValue,
    isMeaningfulText,
    isTestingInfrastructureTicket,
    parseSelfReviewCycles,
    requiresFeatureProofGovernance,
    resolveTicketTier,
    classifyReviewLensBuckets,
    normalizeReviewVerdict,
  } = deps;

  function isNoneLikePlanValue(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "none" || normalized === "not-required" || normalized === "n/a";
  }

  function collectBoundedRepairEligibilityIssues(planState, requirementClosure) {
    const issues = [];
    const intendedFiles = (planState.intended_files || []).filter((value) => isMeaningfulText(value));
    if (intendedFiles.length === 0 || intendedFiles.length > 3) {
      issues.push("bounded repair requires 1-3 intended files to keep the diff narrow");
    }
    if (!fieldHasMeaningfulValue(planState.verification_commands || [])) {
      issues.push("bounded repair requires direct regression verification commands");
    }
    if (!fieldHasMeaningfulValue(planState.repo_gates || [])) {
      issues.push("bounded repair requires recorded repo gates");
    }
    if (!isNoneLikePlanValue(requirementClosure.not_implemented)) {
      issues.push('bounded repair requires "Not implemented: none"');
    }
    if (!isNoneLikePlanValue(requirementClosure.deferred_to)) {
      issues.push('bounded repair requires "Deferred to: none"');
    }
    return issues;
  }

  // COORD-104: extracted from collectReviewPlanReadinessIssues. Aggregates the
  // product-repo (and non-product fallback) closure/gate/invariant/feature-proof
  // blockers. Behavior is byte-identical: same codes, messages, next_steps, and
  // short-circuit ordering as the original inline block.
  function collectClosureReadinessIssues(ticketId, row, planState, board, ctx) {
    const { productRepo, requirementClosure, repoGates, lightLane = false } = ctx;
    const issues = [];
    if (productRepo) {
      // COORD-029: tier-appropriate minimums. For `standard`/absent and `critical`
      // these resolve to the flat (today) values, so enforcement is byte-identical;
      // only a lower tier (e.g. `mechanical`) can relax below them.
      const criticalInvariants = (planState.critical_invariants || []).filter((value) => isMeaningfulText(value));
      const featureProof = (planState.feature_proof || []).filter((value) => isMeaningfulText(value) && !/^todo\b/i.test(String(value || "").trim()));
      const productTier = resolveTicketTier(row).tier;
      // COORD-166: the light lane drops the heavy plan-completeness minimums
      // (critical invariants + feature proofs) for reference/design-doc tickets.
      // The repo-gate equivalent below is NOT relaxed.
      const minCriticalInvariants = lightLane ? 0 : effectiveTierMinimum(productTier, "min_critical_invariants", 2, row);
      const minFeatureProofs = effectiveTierMinimum(productTier, "min_feature_proofs", 1, row);
      if (criticalInvariants.length < minCriticalInvariants) {
        issues.push({
          code: "critical_invariants",
          message: `Plan state for ${ticketId} must record at least ${minCriticalInvariants} meaningful items under "- Critical invariants:" before move-review.`,
          next_steps: [
            `coord/scripts/gov update-plan ${ticketId} --invariant "<first invariant>" --invariant "<second invariant>"`,
          ],
        });
      }
      if (!fieldHasMeaningfulValue(repoGates) || repoGates.some((value) => String(value).trim().toLowerCase() === "not-required")) {
        issues.push({
          code: "repo_gates",
          message: `Plan state for ${ticketId} must record actual repo gate/test commands under "- Repo gates:" before move-review.`,
          next_steps: [
            `coord/scripts/gov update-plan ${ticketId} --repo-gate "<executed gate command>"`,
          ],
        });
      }
      issues.push(...collectRequirementClosureIssues(ticketId, row, requirementClosure, { lightLane }));
      if (
        !lightLane &&
        requiresFeatureProofGovernance(board.metadata, ticketId, row) &&
        !isTestingInfrastructureTicket(row, planState) &&
        featureProof.length < minFeatureProofs
      ) {
        issues.push({
          code: "feature_proof",
          message: `Plan state for ${ticketId} must record canonical "- Feature proof:" entries before move-review.`,
          next_steps: [
            `coord/scripts/gov update-plan ${ticketId} --feature-proof "path:<repo-relative-path>" --feature-proof "symbol:<path>#<symbol-or-literal>"`,
          ],
        });
      }
    } else if (!fieldHasMeaningfulValue(repoGates)) {
      issues.push({
        code: "repo_gates",
        message: `Plan state for ${ticketId} must record "- Repo gates:" with either executed checks or "not-required" before move-review.`,
        next_steps: [
          `coord/scripts/gov update-plan ${ticketId} --repo-gate "not-required"`,
        ],
      });
    }
    return issues;
  }

  // COORD-104: extracted requirement-closure field/verdict blocker. The
  // missing-fields branch and the verdict branch remain mutually exclusive
  // (if/else-if) exactly as in the original.
  function collectRequirementClosureIssues(ticketId, row, requirementClosure, ctx = {}) {
    // COORD-166: light lane (docs/chore reference-doc tickets) only needs a
    // minimal one-line rationale — a non-empty Ticket ask OR Implemented note —
    // instead of the full 5-field closure + complete-verdict gate. It does NOT
    // remove the requirement of *some* attributed rationale.
    if (ctx.lightLane) {
      if (!isMeaningfulText(requirementClosure.ticket_ask) && !isMeaningfulText(requirementClosure.implemented)) {
        return [{
          code: "requirement_closure",
          message: `Plan state for ${ticketId} (light lane) must record a one-line rationale under "- Requirement closure:" (Ticket ask or Implemented) before move-review.`,
          next_steps: [
            `coord/scripts/gov update-plan ${ticketId} --closure "Ticket ask: <one-line rationale>" --closure "Implemented: <what changed>"`,
          ],
        }];
      }
      return [];
    }
    const missingRequirementFields = [
      ["ticket_ask", "Ticket ask"],
      ["implemented", "Implemented"],
      ["not_implemented", "Not implemented"],
      ["deferred_to", "Deferred to"],
      ["closeout_verdict", "Closeout verdict"],
    ].filter(([key]) => !isMeaningfulText(requirementClosure[key]));
    if (missingRequirementFields.length > 0) {
      return [{
        code: "requirement_closure",
        message: `Plan state for ${ticketId} must record explicit "- Requirement closure:" entries for ${missingRequirementFields.map(([, label]) => label).join(", ")} before move-review.`,
        next_steps: [
          `coord/scripts/gov update-plan ${ticketId} --closure "Ticket ask: <ticket ask>" --closure "Implemented: <what landed>" --closure "Not implemented: <gap or none>" --closure "Deferred to: <ticket-id or none>" --closure "Closeout verdict: complete|incomplete"`,
        ],
      }];
    }
    if (requirementClosure.closeout_verdict !== "complete") {
      return [{
        code: "requirement_closure_verdict",
        message: `Plan state for ${ticketId} cannot move to review while "- Requirement closure:" says Closeout verdict: ${requirementClosure.closeout_verdict}. Open or link follow-up tickets first, then update the verdict to complete.`,
        next_steps: [
          `coord/scripts/gov open-followup <new-ticket-id> --depends-on ${ticketId} --repo ${row.Repo} --type followup --pri P0 --description "<remaining gap>" --relation closeout-blocker`,
          `coord/scripts/gov update-plan ${ticketId} --closure "Deferred to: <ticket-id or none>" --closure "Closeout verdict: complete"`,
        ],
      }];
    }
    return [];
  }

  // COORD-104: extracted the canonical-vs-legacy self-review cycle snapshot
  // derivation. Maps the canonical plan-record cycles into the same evaluation
  // shape produced by parseSelfReviewCycles, byte-for-byte unchanged.
  function buildReviewCycleSnapshots(planState, canonicalPlanRecord, block) {
    if (!(Array.isArray(planState.self_review_cycles) && (canonicalPlanRecord || planState.self_review_cycles.length > 0))) {
      return parseSelfReviewCycles(block);
    }
    return planState.self_review_cycles.map((cycle) => ({
      cycle: cycle.cycle,
      total: cycle.total,
      body: cycle.raw,
      lens: cycle.lens,
      diff: cycle.diff,
      risks: Array.isArray(cycle.risks) ? cycle.risks.join(", ") : "",
      findings: cycle.findings,
      verification: cycle.verification,
      riskCount: Array.isArray(cycle.risks) ? cycle.risks.length : 0,
      lensBuckets: classifyReviewLensBuckets(cycle.lens),
      missingFields: ["lens", "diff", "findings", "verification", "verdict"].filter((field) => !isMeaningfulText(cycle[field])),
      structured:
        isMeaningfulText(cycle.lens) &&
        isMeaningfulText(cycle.diff) &&
        Array.isArray(cycle.risks) &&
        cycle.risks.length > 0 &&
        isMeaningfulText(cycle.findings) &&
        isMeaningfulText(cycle.verification) &&
        isMeaningfulText(cycle.verdict),
      verdictRaw: cycle.verdict,
      verdict: normalizeReviewVerdict(cycle.verdict),
    }));
  }

  // COORD-104: extracted the self-review-cycle blockers (count/structure/risk
  // depth/lens coverage/final verdict). Issue codes, messages, next_steps, and
  // evaluation order are byte-identical to the original inline block.
  function collectSelfReviewCycleIssues(ticketId, row, cycles, ctx) {
    const { productRepo, boundedRepairRequested, boundedRepairEligibilityIssues, lightLane = false } = ctx;
    const issues = [];
    const reviewCycleCommand = `coord/scripts/gov update-plan ${ticketId} --review-cycle "lens=<lens>; diff=<what changed>; risks=<risk 1>, <risk 2>; findings=<none|finding>; verification=<command>; verdict=<pass|fail>"`;
    // COORD-029: flat (pre-tier) minimum, computed exactly as before. The tier
    // policy may only RELAX this below the flat value for a lower tier; `standard`
    // (and absent) and `critical` resolve back to flatMinimumCycles unchanged, so
    // their enforcement is byte-identical to pre-COORD-029 behavior.
    // COORD-166: the light lane requires at least ONE structured, non-shallow,
    // passing self-review cycle (a minimal self-review) instead of the full
    // 3-/4-cycle ceremony. The structure/shallow/final-verdict checks below still
    // apply, so the single cycle must still be real.
    const flatMinimumCycles = lightLane
      ? 1
      : productRepo
      ? (boundedRepairRequested && boundedRepairEligibilityIssues.length === 0 ? 3 : 4)
      : 3;
    const ticketTier = resolveTicketTier(row).tier;
    const minimumCycles = effectiveTierMinimum(ticketTier, "min_review_cycles", flatMinimumCycles, row);
    if (cycles.length < minimumCycles) {
      issues.push({
        code: "self_review_cycle_count",
        message: `Plan state for ${ticketId} must record at least ${minimumCycles} self-review cycles before move-review.`,
        next_steps: [reviewCycleCommand],
      });
    }
    const malformedCycle = cycles.find((cycle) => !cycle.structured);
    if (malformedCycle) {
      issues.push({
        code: "self_review_cycle_incomplete",
        message: `Plan state for ${ticketId} has an incomplete self-review cycle (${malformedCycle.cycle}/${malformedCycle.total}). Each cycle must include lens=, diff=, risks=, findings=, verification=, and verdict=.`,
        next_steps: [reviewCycleCommand],
      });
    }
    const shallowRiskCycle = cycles.find((cycle) => cycle.riskCount < 2);
    if (shallowRiskCycle) {
      issues.push({
        code: "self_review_cycle_shallow",
        message: `Plan state for ${ticketId} has a shallow self-review cycle (${shallowRiskCycle.cycle}/${shallowRiskCycle.total}). "risks=" must name at least 2 concrete failure modes, comma-separated.`,
        next_steps: [reviewCycleCommand],
      });
    }
    if (productRepo && !lightLane && cycles.length >= minimumCycles) {
      const lensCoverage = new Set(cycles.flatMap((cycle) => cycle.lensBuckets));
      const requiredCoverage = boundedRepairRequested && boundedRepairEligibilityIssues.length === 0
        ? [
            "contract/state invariants",
            "auth/security/failure modes",
            "tests/operability/performance",
          ]
        : [
            "contract/state invariants",
            "auth/security/failure modes",
            "tests/operability/performance",
            "requirement closure",
          ];
      const missingCoverage = requiredCoverage.filter((bucket) => !lensCoverage.has(bucket));
      if (missingCoverage.length > 0) {
        issues.push({
          code: "self_review_lens_coverage",
          message: `Plan state for ${ticketId} must cover distinct self-review lenses across ${requiredCoverage.join(", ")} before move-review. Missing: ${missingCoverage.join(", ")}.`,
          next_steps: [reviewCycleCommand],
        });
      }
    }
    const lastCycle = cycles[cycles.length - 1];
    if (cycles.length > 0 && lastCycle?.verdict !== "pass") {
      issues.push({
        code: "self_review_final_verdict",
        message: `Plan state for ${ticketId} must end with a passing self-review cycle before move-review.`,
        next_steps: [reviewCycleCommand],
      });
    }
    return issues;
  }

  function collectSubagentSupervisionIssues(ticketId) {
    const report = supervisionReport(path.join(coordDir, ".runtime", "subagents", `${ticketId}.json`), ticketId);
    if (report.ok) return [];
    return [{
      code: "subagent_supervision",
      message: `Ticket ${ticketId} cannot close with active or unexplained subagent work (active=${report.active.join(",") || "none"}; unexplained=${report.unexplained.join(",") || "none"}).`,
      next_steps: ["Finish or stop every child session, record its result and action digest, then rerun gov explain."],
    }];
  }

  return {
    buildReviewCycleSnapshots,
    collectBoundedRepairEligibilityIssues,
    collectClosureReadinessIssues,
    collectRequirementClosureIssues,
    collectSelfReviewCycleIssues,
    collectSubagentSupervisionIssues,
    isNoneLikePlanValue,
  };
}

module.exports = {
  createReviewCloseoutGate,
};
