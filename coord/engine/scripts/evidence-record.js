"use strict";

// COORD-959: one evidence-record check. It replaces the three verb guards
// repo-gate-record, gate-plan-receipt and closeout-landing-evidence (human-admin
// approved 2026-11-12; ADR 0021; run manifests per COORD-910). Blocker codes and
// refusal messages are unchanged. Old guard -> merged check mapping:
//   repo-gate-record          -> repoGatesProductIssue / repoGatesNonProductIssue (code repo_gates)
//   gate-plan-receipt         -> collectGatePlanReadinessIssues (codes gate_plan_receipt,
//                                gate_plan_stale, gate_plan_slice_receipt; evidence codes pass through)
//   closeout-landing-evidence -> the landing message builders below, called from closeout.js and
//                                landing-gh.js; the refusal control flow stays in those modules.
const { riskGte } = require("./track-evidence-policy.js");

// guard:evidence-record
function repoGatesProductIssue(ticketId) {
  return {
    code: "repo_gates",
    message: `Plan state for ${ticketId} must record actual repo gate/test commands under "- Repo gates:" before move-review.`,
    next_steps: [
      `coord/scripts/gov update-plan ${ticketId} --repo-gate "<executed gate command>"`,
    ],
  };
}

// guard:evidence-record
function repoGatesNonProductIssue(ticketId) {
  return {
    code: "repo_gates",
    message: `Plan state for ${ticketId} must record "- Repo gates:" with either executed checks or "not-required" before move-review.`,
    next_steps: [
      `coord/scripts/gov update-plan ${ticketId} --repo-gate "not-required"`,
    ],
  };
}

// guard:evidence-record
function landedEvidenceUnresolvableMessage(ticketId) {
  return (
    `Ticket ${ticketId} uses manual landing evidence but no resolvable commit SHA. ` +
    'Pass --landed "<canonical-branch commit-sha and closeout note>". ' +
    "Refusing before the merge (COORD-703): this check previously ran after it, which is how a " +
    "merged PR came to exist with no board record."
  );
}

// guard:evidence-record
function explicitSourceCommitUnresolvableMessage(ticketId, sourceCommit, repoRoot) {
  return (
    `Ticket ${ticketId} names source commit "${sourceCommit}", which does not resolve in ` +
    `${repoRoot}. Refusing before the merge: an unresolvable provenance claim is a defect in the ` +
    "landing, and silently falling back to the worktree head would record a different commit than " +
    "the one named."
  );
}

// guard:evidence-record
function alreadyMergedUnmeasuredHeadMessage(url, viewedHead, reviewedHead) {
  return (
    `PR ${url} was already merged at head ${viewedHead || "(unknown)"}, not the reviewed head ${reviewedHead} the closeout qualified. ` +
    "Refusing to record a merge whose landed head was not measured. Recovery: re-measure the decomposition-proof at the merged head " +
    `(coord/scripts/gov update-plan <ticket> --repo-gate "decomposition-proof: ...") and re-run closeout with --source-commit ${viewedHead || "<merged head>"}.`
  );
}

// guard:evidence-record
function unmeasuredHeadMessage(url, viewedHead, reviewedHead) {
  return (
    `PR ${url} head is ${viewedHead || "(unknown)"}, not the reviewed head ${reviewedHead} the closeout qualified. ` +
    "Refusing to merge a head that was not measured: review the new head and re-run closeout with --source-commit <new head>."
  );
}

// guard:evidence-record
function gatePlanIsMissingOrStale(planState = {}, options = {}) {
  const receipt = planState.gate_plan;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { missing: true, stale: false, reason: "missing gate-plan receipt" };
  }
  if (receipt.planner_version !== "gate-plan-v1") {
    return { missing: false, stale: true, reason: "unsupported gate-plan planner_version" };
  }
  const maxAgeDays = Number(options.maxAgeDays || 14);
  const generated = Date.parse(receipt.generated_at);
  const now = Date.parse(options.now || new Date().toISOString());
  if (!Number.isNaN(generated) && !Number.isNaN(now) && now - generated > maxAgeDays * 24 * 60 * 60 * 1000) {
    return { missing: false, stale: true, reason: `gate-plan receipt is older than ${maxAgeDays} days` };
  }
  return { missing: false, stale: false, reason: null };
}

function collectGatePlanReadinessIssues(ticketId, row, planState = {}, options = {}) {
  const status = gatePlanIsMissingOrStale(planState, options);
  const lightLane = options.lightLane === true;
  const issues = [];
  if ((status.missing || status.stale) && !lightLane) {
    const riskText = [
      row?.Description,
      row?.Type,
      row?.Pri,
      planState?.bootstrap_risk?.startup_work_class,
      planState?.live_mcp?.operation_class,
    ].join("\n");
    const hardMissing = /prod|deploy|server_bootstrap_job|derived_data_job|production_repair|write_prod|destructive|auth|rbac|journal|signing/i.test(riskText);
    issues.push({
      code: status.missing ? "gate_plan_receipt" : "gate_plan_stale",
      message: `Plan state for ${ticketId} ${status.reason}; record deterministic selected/skipped gate evidence before review.`,
      next_steps: [`coord/scripts/gov gate-plan ${ticketId} --write`],
      severity: hardMissing ? "blocker" : "advisory",
    });
  }

  const receipt = planState.gate_plan;
  if (receipt && typeof receipt === "object") {
    const mode = String(receipt.affected_targets?.mode || "");
    if (mode === "slice" && !Array.isArray(receipt.affected_targets?.selected)) {
      issues.push({
        code: "gate_plan_slice_receipt",
        message: `Plan state for ${ticketId} claims affected-target slice mode without selected target receipt details.`,
        next_steps: [`coord/scripts/gov gate-plan ${ticketId} --write`],
        severity: "blocker",
      });
    }
    const receiptBlocks =
      receipt.enforcement === "blocking" ||
      riskGte(receipt.risk_class, "R3");
    const blockingEvidence = receiptBlocks
      ? (receipt.evidence_issues || []).filter((issue) => issue.severity === "blocker")
      : [];
    for (const issue of blockingEvidence) {
      issues.push({
        code: issue.code,
        message: issue.message,
        next_steps: issue.next_steps || [`coord/scripts/gov gate-plan ${ticketId} --write`],
        severity: "blocker",
      });
    }
  }
  return issues.filter((issue) => issue.severity !== "advisory" || options.includeAdvisory === true);
}

module.exports = {
  alreadyMergedUnmeasuredHeadMessage,
  collectGatePlanReadinessIssues,
  explicitSourceCommitUnresolvableMessage,
  gatePlanIsMissingOrStale,
  landedEvidenceUnresolvableMessage,
  repoGatesNonProductIssue,
  repoGatesProductIssue,
  unmeasuredHeadMessage,
};
