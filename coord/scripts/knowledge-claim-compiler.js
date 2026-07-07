#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const evidenceAuthority = require("./evidence-authority.js");
const memoryClassification = require("./memory-classification.js");

const ARTIFACT_KIND = "concord.knowledge_claim_compiler.run";

const COMPILER_CONTRACT = Object.freeze({
  name: "Concord Knowledge Compiler",
  purpose: "Gate source-backed claims before they become governed knowledge or ticket context.",
  producers: Object.freeze([
    "business_discovery",
    "ticket_execution",
    "requirements_assurance",
    "adr_decision_records",
    "review_feedback",
  ]),
  consumers: Object.freeze([
    "memory",
    "recall",
    "context_packs",
    "requirements",
    "adrs",
    "ticket_synthesis",
  ]),
  memory_taxonomy: Object.freeze({
    domain_knowledge: "semantic_memory",
    behavioral_knowledge: "semantic_memory",
    procedural_rules: "procedural_memory",
    operational_events: "operational_memory",
    decisions: "decision_memory",
  }),
  guardrail: "Memory recommends; governance decides; sources are cited; execution remains gated.",
  vector_role: "retrieval_view_only",
});

const CONTINUITY_LADDER = Object.freeze({
  states: Object.freeze(["scratch", "observed", "candidate", "robust", "stale", "superseded", "rejected"]),
  authoritative_states: Object.freeze(["robust"]),
  context_pack_states: Object.freeze(["robust"]),
  history_only_states: Object.freeze(["stale", "superseded", "rejected"]),
  robust_promotion_targets: Object.freeze([
    "memory_claim",
    "adr",
    "ticket",
    "runbook",
    "adapter",
    "cadence_rule",
  ]),
});

const DEFAULT_POLICY = {
  max_claims_per_ticket: 3,
  max_claims_per_reviewer: 10,
  allow_context_pack_statuses: ["accepted", "candidate", "review-required"],
  authoritative_intent: ["approved_policy", "accepted_decision", "requirement", "human_review_comment"],
  enforcement: ["test_proof", "implementation", "runtime_observation"],
  secret_visibility: ["secret_prohibited", "sensitive"],
  risky_ticket_kinds: ["behavior_change", "data_migration", "runtime_change", "policy_change"],
  policy_claim_kinds: ["policy_rule", "business_rule", "governance_rule", "procedural_rule", "rule", "policy"],
  extraction_precision_thresholds: {
    min_proposed_claim_precision: 0.8,
    min_promoted_claim_precision: 0.95,
    min_auto_reject_accuracy: 0.9,
    min_conflict_detection: 1,
    min_groundedness: 0.9,
    max_false_authority_rate: 0.02,
    max_review_required_per_case: 10,
  },
};

const PROMPT_INJECTION_PATTERNS = Object.freeze([
  /\bignore (?:all )?(?:previous|prior|above|system|developer) instructions\b/i,
  /\bdisregard (?:all )?(?:previous|prior|above|system|developer) instructions\b/i,
  /\byou are now\b/i,
  /\btreat this (?:document|comment|note|receipt|page|resource) as (?:system|developer|highest authority)\b/i,
  /\bdo not tell\b/i,
  /\bhide (?:this|these) (?:instructions|rules|messages)\b/i,
  /\breveal (?:the )?(?:secret|token|password|api[_ -]?key|system prompt|developer message)\b/i,
  /\bexfiltrat(?:e|ion)\b/i,
]);

const GOVERNANCE_OVERRIDE_PATTERNS = Object.freeze([
  /\bbypass governance\b/i,
  /\bskip (?:self[- ]?review|review|tests?|gates?|validation)\b/i,
  /\bmark .* done without\b/i,
  /\bland immediately\b/i,
  /\bpromote .* (?:without|no) (?:review|approval|evidence)\b/i,
  /\bsupersede[sd]? (?:coord\/GOVERNANCE\.md|governance)\b/i,
  /\bchange (?:the )?(?:agent|procedural|governance) rules\b/i,
]);

const POLICY_LANGUAGE = /\b(must|shall|required|require|requires|prohibited|forbidden|allowed|may bypass|policy|governance|agent behavior|procedural memory)\b/i;

const EVIDENCE_TEXT_FIELDS = Object.freeze([
  "body",
  "content",
  "snippet",
  "text",
  "raw",
  "payload",
  "note",
  "notes",
  "message",
]);

function parseArgs(argv = []) {
  const options = { input: null, json: false, output: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--input", "--output"].includes(arg)) {
      const key = arg.slice(2);
      const value = argv[++i];
      if (!value) return { error: `${arg} requires a value` };
      options[key] = value;
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  if (!options.input) return { error: "--input is required" };
  return { options };
}

function normalizeInput(input) {
  if (Array.isArray(input)) return { claims: input, policy: {} };
  return {
    claims: Array.isArray(input?.claims) ? input.claims : [],
    policy: input?.policy || {},
    context: input?.context || {},
  };
}

function sourceAuthorities(claim) {
  return (claim.evidence || []).map((evidence) => evidence.authority || evidence.evidence_role || "unknown");
}

function sourceVisibilities(claim) {
  return (claim.evidence || []).map((evidence) => evidence.visibility || claim.classification || "internal");
}

function hasOnlySummaryEvidence(claim) {
  const evidence = claim.evidence || [];
  return evidence.length > 0 && evidence.every((item) => (item.authority || item.evidence_role) === "summary");
}

function isSecretTainted(claim, policy) {
  if (policy.secret_visibility.includes(claim.classification)) return true;
  return sourceVisibilities(claim).some((visibility) => policy.secret_visibility.includes(visibility));
}

function claimTextFields(claim) {
  return [
    claim.statement,
    claim.rationale,
    claim.reason,
    claim.description,
    claim.proposed_rule,
  ].filter((value) => value !== undefined && value !== null).map(String);
}

function evidenceTextFields(evidence) {
  const values = [];
  for (const field of EVIDENCE_TEXT_FIELDS) {
    if (evidence && evidence[field] !== undefined && evidence[field] !== null) {
      values.push(evidence[field]);
    }
  }
  return values;
}

function sourceRef(evidence, index) {
  return {
    index,
    type: evidence.type || evidence.kind || "evidence",
    source_id: evidence.source_id || evidence.id || null,
    path: evidence.path || evidence.source_path || null,
    authority: evidence.authority || evidence.evidence_role || "unknown",
    visibility: evidence.visibility || "internal",
  };
}

function matchesAnyPattern(values, patterns) {
  return values.some((value) => patterns.some((pattern) => pattern.test(String(value))));
}

function scanAdversarialTaint(claim) {
  const textValues = claimTextFields(claim);
  const evidence = claim.evidence || [];
  const taintCodes = new Set();
  const taintedSources = [];

  if (matchesAnyPattern(textValues, PROMPT_INJECTION_PATTERNS)) taintCodes.add("prompt_injection");
  if (matchesAnyPattern(textValues, GOVERNANCE_OVERRIDE_PATTERNS)) taintCodes.add("governance_override");
  if (memoryClassification.looksLikeSecret(textValues)) taintCodes.add("secret_tainted");

  evidence.forEach((item, index) => {
    const fields = evidenceTextFields(item);
    const sourceCodes = [];
    if (matchesAnyPattern(fields, PROMPT_INJECTION_PATTERNS)) sourceCodes.push("prompt_injection");
    if (matchesAnyPattern(fields, GOVERNANCE_OVERRIDE_PATTERNS)) sourceCodes.push("governance_override");
    if (memoryClassification.looksLikeSecret(item)) sourceCodes.push("secret_tainted");
    for (const code of sourceCodes) taintCodes.add(code);
    if (sourceCodes.length > 0) {
      taintedSources.push({ ...sourceRef(item, index), taint_codes: Array.from(new Set(sourceCodes)).sort() });
    }
  });

  return {
    taint_codes: Array.from(taintCodes).sort(),
    tainted_source_refs: taintedSources,
  };
}

function isPolicyOrRuleClaim(claim, policy) {
  const kind = String(claim.kind || claim.type || claim.category || "").toLowerCase();
  if (policy.policy_claim_kinds.includes(kind)) return true;
  const predicate = String(claim.predicate || "").toLowerCase();
  if (/\b(policy|rule|governance|procedure|required|allowed|prohibited)\b/.test(predicate)) return true;
  return POLICY_LANGUAGE.test(String(claim.statement || ""));
}

function hasAuthoritativeIntent(claim, policy) {
  return sourceAuthorities(claim).some((authority) => policy.authoritative_intent.includes(authority));
}

function hasEnforcement(claim, policy) {
  return sourceAuthorities(claim).some((authority) => policy.enforcement.includes(authority));
}

function confidenceForClaim(claim) {
  return evidenceAuthority.computeConfidence(claim, claim.evidence || []);
}

function evidenceHashDrifted(evidence) {
  if (evidence.freshness === "stale" || evidence.source_hash_status === "stale" || evidence.hash_status === "stale") return true;
  if (evidence.source_changed === true || evidence.source_missing === true) return true;
  const expected = evidence.source_hash || evidence.recorded_source_hash || evidence.expected_source_hash;
  const actual = evidence.current_source_hash || evidence.actual_source_hash;
  return Boolean(expected && actual && expected !== actual);
}

function hasSourceHashDrift(claim) {
  if (claim.status === "stale" || claim.stale === true) return true;
  return (claim.evidence || []).some(evidenceHashDrifted);
}

function claimId(claim) {
  return claim.id || claim.candidate_id || null;
}

function reviewerKey(claim) {
  return claim.reviewer || claim.review_owner || claim.owner || "unassigned";
}

function levelFor(claim, policy) {
  const computed = confidenceForClaim(claim);
  if (claim.status === "rejected" || claim.rejected === true) return "rejected";
  if (claim.superseded_by || claim.status === "superseded") return "superseded";
  if (hasSourceHashDrift(claim)) return "stale";
  if (Array.isArray(claim.conflicts_with) && claim.conflicts_with.length > 0) return "conflicted";
  if (claim.status === "scratch" || claim.mode === "scratch") return "scratch";
  if (computed.confidence === "confirmed") return "accepted";
  if (hasAuthoritativeIntent(claim, policy) && hasEnforcement(claim, policy)) return "review-required";
  if (hasAuthoritativeIntent(claim, policy)) return "candidate";
  if (hasEnforcement(claim, policy)) return "observed_only";
  return "quarantined";
}

function continuityStateFor({ outcome, promotionLevel }) {
  if (outcome === "stale") return "stale";
  if (outcome === "superseded") return "superseded";
  if (outcome === "rejected") return "rejected";
  if (outcome === "conflicted") return "candidate";
  if (outcome === "accepted" || promotionLevel === "accepted") return "robust";
  if (promotionLevel === "scratch") return "scratch";
  if (promotionLevel === "observed_only") return "observed";
  if (outcome === "candidate" || outcome === "review-required" || promotionLevel === "candidate" || promotionLevel === "review-required") return "candidate";
  return "scratch";
}

function normalizePromotionTargets(claim, continuityState) {
  if (continuityState !== "robust") return [];
  const requested = Array.isArray(claim.promotion_targets)
    ? claim.promotion_targets
    : Array.isArray(claim.promotionTargets)
      ? claim.promotionTargets
      : claim.promotion_target
        ? [claim.promotion_target]
        : [];
  const allowed = new Set(CONTINUITY_LADDER.robust_promotion_targets);
  const normalized = requested.map(String).filter((target) => allowed.has(target));
  if (normalized.length > 0) return Array.from(new Set(normalized)).sort();
  return ["memory_claim"];
}

function continuitySemantics(claim, outcome, promotionLevel, eligible) {
  const state = continuityStateFor({ outcome, promotionLevel });
  const historyOnly = CONTINUITY_LADDER.history_only_states.includes(state);
  const robust = state === "robust";
  return {
    continuity_state: state,
    authoritative: robust,
    retrievable: true,
    history_only: historyOnly,
    can_feed_context_pack: Boolean(eligible && robust),
    promotion_targets: normalizePromotionTargets(claim, state),
  };
}

function outcomeFor(claim, policy, budgetState) {
  const reasons = [];
  const evidence = claim.evidence || [];
  const taint = scanAdversarialTaint(claim);

  if (!claim.statement || !String(claim.statement).trim()) {
    return reject(claim, "missing_statement", "Claim has no statement.", { taint });
  }
  if (evidence.length === 0) {
    return reject(claim, "missing_evidence", "Claim has no source evidence.", { taint });
  }
  if (taint.taint_codes.includes("secret_tainted")) {
    return reject(claim, "secret_tainted", "Secret-like claim or evidence content is quarantined and cannot enter shared knowledge/context packs.", { taint });
  }
  if (taint.taint_codes.includes("prompt_injection")) {
    return reject(claim, "prompt_injection", "Prompt-injection content is preserved only as inert audit evidence and cannot promote a claim.", { taint });
  }
  if (taint.taint_codes.includes("governance_override")) {
    return reject(claim, "governance_override", "Governance-override content is preserved only as inert audit evidence and cannot alter procedures.", { taint });
  }
  if (hasOnlySummaryEvidence(claim)) {
    return reject(claim, "summary_only_evidence", "Summaries can guide navigation but cannot prove claims.", { taint });
  }
  if (isSecretTainted(claim, policy)) {
    return reject(claim, "secret_tainted", "Secret or sensitive evidence cannot enter shared knowledge/context packs.", { taint });
  }
  if (isPolicyOrRuleClaim(claim, policy) && !hasAuthoritativeIntent(claim, policy)) {
    return reject(claim, "unauthoritative_policy_claim", "Policy, business-rule, governance-rule, and procedural-rule claims require authoritative evidence before review or promotion.", { taint });
  }

  const level = levelFor(claim, policy);
  if (level === "superseded") {
    return buildOutcome(claim, "superseded", level, ["Claim is superseded and can only be used as historical context."], false, "history_only", { taint });
  }
  if (level === "stale") {
    return buildOutcome(claim, "stale", level, ["Claim source hashes no longer match the recorded evidence and must be revalidated before use."], false, "stale_revalidation", { taint });
  }
  if (level === "conflicted") {
    return buildOutcome(claim, "conflicted", level, ["Claim declares active conflicts and must be resolved before governing work."], false, "conflict_queue", { taint });
  }
  if (level === "rejected") {
    return buildOutcome(claim, "rejected", level, ["Claim has been explicitly rejected and is retained only to explain history or avoid repeated dead ends."], false, "rejected_history", { taint });
  }
  if (level === "scratch") {
    return buildOutcome(claim, "scratch", level, ["Scratch record is retrievable continuity residue, not authoritative context."], false, "scratch_retrieval", { taint });
  }

  const key = reviewerKey(claim);
  budgetState.byReviewer.set(key, (budgetState.byReviewer.get(key) || 0) + 1);
  budgetState.total += 1;
  if (budgetState.total > policy.max_claims_per_ticket) {
    return buildOutcome(claim, "review-required", level, ["Reviewer budget exceeded for this ticket; route through review queue before promotion."], false, "review_queue", { taint });
  }
  if (budgetState.byReviewer.get(key) > policy.max_claims_per_reviewer) {
    return buildOutcome(claim, "review-required", level, [`Reviewer budget exceeded for ${key}.`], false, "review_queue", { taint });
  }

  if (level === "accepted") {
    reasons.push("Claim has reviewer approval or deterministic verification.");
    return buildOutcome(claim, "accepted", level, reasons, true, "promoted", { taint });
  }
  if (level === "review-required") {
    reasons.push("Claim has intent and enforcement evidence but still requires review before becoming truth.");
    return buildOutcome(claim, "review-required", level, reasons, true, "review_queue", { taint });
  }
  if (level === "candidate") {
    reasons.push("Claim has intent evidence but lacks enforcement/test corroboration.");
    return buildOutcome(claim, "candidate", level, reasons, true, "question_or_ticket", { taint });
  }
  if (level === "observed_only") {
    reasons.push("Claim is implementation/runtime/test observed behavior, not proven intent.");
    return buildOutcome(claim, "candidate", level, reasons, true, "question_or_ticket", { taint });
  }
  return buildOutcome(claim, "rejected", level, ["Claim lacks enough evidence to reach a reviewer queue."], false, "quarantine", { taint });
}

function reject(claim, code, reason, metadata = {}) {
  return buildOutcome(claim, "rejected", "rejected", [reason], false, code, metadata);
}

function buildOutcome(claim, outcome, promotionLevel, reasons, contextPackEligible, route, metadata = {}) {
  const computed = confidenceForClaim(claim);
  const taint = metadata.taint || { taint_codes: [], tainted_source_refs: [] };
  const eligible = Boolean(
    contextPackEligible &&
    !["scratch", "rejected", "conflicted", "superseded", "stale"].includes(outcome) &&
    taint.taint_codes.length === 0
  );
  const continuity = continuitySemantics(claim, outcome, promotionLevel, eligible);
  return {
    claim_id: claimId(claim),
    subject: claim.subject || null,
    predicate: claim.predicate || null,
    statement: claim.statement || "",
    context_pack_statement: eligible ? claim.statement || "" : null,
    outcome,
    promotion_level: promotionLevel,
    computed_confidence: computed.confidence,
    confidence_score: computed.score,
    confidence_inputs: computed.inputs,
    context_pack_eligible: eligible,
    continuity_state: continuity.continuity_state,
    continuity,
    route,
    reasons,
    source_count: (claim.evidence || []).length,
    source_authorities: sourceAuthorities(claim),
    audit: {
      rejection_code: outcome === "rejected" ? route : null,
      taint_codes: taint.taint_codes,
      tainted_source_refs: taint.tainted_source_refs,
      evidence_refs: (claim.evidence || []).map(sourceRef),
    },
  };
}

function forceConflicted(outcome, reason) {
  const continuity = {
    ...(outcome.continuity || {}),
    continuity_state: "candidate",
    authoritative: false,
    retrievable: true,
    history_only: false,
    can_feed_context_pack: false,
    promotion_targets: [],
  };
  return {
    ...outcome,
    outcome: "conflicted",
    promotion_level: "conflicted",
    continuity_state: continuity.continuity_state,
    continuity,
    computed_confidence: "contradicted",
    confidence_score: Math.max(0, Math.min(outcome.confidence_score || 0, 40)),
    confidence_inputs: {
      ...(outcome.confidence_inputs || {}),
      conflict_state: "conflicted",
    },
    context_pack_eligible: false,
    route: "conflict_queue",
    reasons: Array.from(new Set([...(outcome.reasons || []), reason])),
  };
}

function applyAcceptedConflictPolicy(claims, outcomes) {
  const byId = new Map(outcomes.map((outcome, index) => [outcome.claim_id, { outcome, index }]));
  const conflictIndexes = new Set();

  for (const [index, claim] of claims.entries()) {
    const id = claimId(claim);
    for (const otherId of claim.conflicts_with || []) {
      const current = byId.get(id);
      const other = byId.get(otherId);
      if (!current || !other) continue;
      const active = [current.outcome, other.outcome].every((outcome) => !["rejected", "superseded", "stale"].includes(outcome.outcome));
      if (active) {
        conflictIndexes.add(current.index);
        conflictIndexes.add(other.index);
      }
    }

    if (!claim.conflict_key) continue;
    const matching = claims
      .map((otherClaim, otherIndex) => ({ otherClaim, otherIndex }))
      .filter(({ otherClaim, otherIndex }) => otherIndex !== index && otherClaim.conflict_key === claim.conflict_key);
    if (matching.length === 0) continue;
    const currentOutcome = outcomes[index];
    if (!["accepted", "review-required", "candidate"].includes(currentOutcome.outcome)) continue;
    for (const { otherIndex } of matching) {
      if (["accepted", "review-required", "candidate"].includes(outcomes[otherIndex].outcome)) {
        conflictIndexes.add(index);
        conflictIndexes.add(otherIndex);
      }
    }
  }

  if (conflictIndexes.size === 0) return outcomes;
  return outcomes.map((outcome, index) => (
    conflictIndexes.has(index)
      ? forceConflicted(outcome, "Accepted or reviewable claim conflicts with another active claim; resolve or supersede before active use.")
      : outcome
  ));
}

function isRiskyBehaviorChange(context, policy) {
  if (context.risky_behavior_change === true || context.behavior_changing === true) return true;
  const kind = context.ticket_kind || context.change_kind || context.risk_class;
  return Boolean(kind && policy.risky_ticket_kinds.includes(kind));
}

function isRiskApprovedOrWaived(context) {
  return context.risk_approval === true || context.risk_waiver === true || context.memory_conflict_waiver === true;
}

function riskyGateFor(outcomes, context, policy) {
  const risky = isRiskyBehaviorChange(context || {}, policy);
  const approvedOrWaived = isRiskApprovedOrWaived(context || {});
  const blockers = outcomes
    .filter((outcome) => outcome.outcome === "conflicted" || outcome.promotion_level === "observed_only" || outcome.inferred === true)
    .map((outcome) => ({
      claim_id: outcome.claim_id,
      outcome: outcome.outcome,
      promotion_level: outcome.promotion_level,
      reason: outcome.outcome === "conflicted" ? "conflicted_claim" : "inferred_or_observed_only_claim",
    }));
  return {
    risky_behavior_change: risky,
    approved_or_waived: approvedOrWaived,
    blocked: Boolean(risky && !approvedOrWaived && blockers.length > 0),
    blockers: risky && !approvedOrWaived ? blockers : [],
  };
}

function governedControlForOutcome(claim, outcome, generatedAtUtc) {
  if (outcome.outcome === "rejected") {
    const secretTainted = (outcome.audit?.taint_codes || []).includes("secret_tainted");
    return memoryClassification.buildMemoryControlRecord(
      secretTainted ? "redact" : "reject",
      {
        ...claim,
        claim_id: outcome.claim_id,
        status: "active",
      },
      {
        reason: outcome.reasons.join(" "),
        reason_code: outcome.audit?.rejection_code || outcome.route,
        fields: secretTainted ? ["statement", "evidence"] : [],
        createdAtUtc: generatedAtUtc,
      }
    );
  }
  if (outcome.outcome === "superseded") {
    return memoryClassification.buildMemoryControlRecord(
      "supersede",
      {
        ...claim,
        claim_id: outcome.claim_id,
        status: "active",
      },
      {
        reason: outcome.reasons.join(" "),
        superseded_by: claim.superseded_by,
        createdAtUtc: generatedAtUtc,
      }
    );
  }
  if (outcome.outcome === "stale") {
    return memoryClassification.buildMemoryControlRecord(
      "demote",
      {
        ...claim,
        claim_id: outcome.claim_id,
        status: "active",
      },
      {
        reason: outcome.reasons.join(" "),
        to_scope: "local-only",
        createdAtUtc: generatedAtUtc,
      }
    );
  }
  return null;
}

function governedControlsForOutcomes(claims, outcomes, generatedAtUtc) {
  const records = [];
  for (let i = 0; i < outcomes.length; i += 1) {
    const record = governedControlForOutcome(claims[i], outcomes[i], generatedAtUtc);
    if (record) records.push(record);
  }
  return records;
}

function compileClaims(input, options = {}) {
  const normalized = normalizeInput(input);
  const policy = { ...DEFAULT_POLICY, ...(normalized.policy || {}), ...(options.policy || {}) };
  const budgetState = { total: 0, byReviewer: new Map() };
  const outcomes = applyAcceptedConflictPolicy(
    normalized.claims,
    normalized.claims.map((claim) => outcomeFor(claim, policy, budgetState))
  );
  const riskGate = riskyGateFor(outcomes, normalized.context || {}, policy);
  const generatedAtUtc = options.generatedAtUtc || "1970-01-01T00:00:00.000Z";
  const governedControls = governedControlsForOutcomes(normalized.claims, outcomes, generatedAtUtc);
  return {
    kind: ARTIFACT_KIND,
    schema_version: 1,
    compiler: COMPILER_CONTRACT,
    generated_at_utc: generatedAtUtc,
    policy: {
      max_claims_per_ticket: policy.max_claims_per_ticket,
      max_claims_per_reviewer: policy.max_claims_per_reviewer,
      context_pack_statuses: policy.allow_context_pack_statuses,
      extraction_precision_thresholds: policy.extraction_precision_thresholds,
      continuity_ladder: CONTINUITY_LADDER,
    },
    outcomes,
    routing: {
      accepted: outcomes.filter((outcome) => outcome.outcome === "accepted").map((outcome) => outcome.claim_id),
      scratch: outcomes.filter((outcome) => outcome.outcome === "scratch").map((outcome) => outcome.claim_id),
      candidate: outcomes.filter((outcome) => outcome.outcome === "candidate").map((outcome) => outcome.claim_id),
      rejected: outcomes.filter((outcome) => outcome.outcome === "rejected").map((outcome) => outcome.claim_id),
      conflicted: outcomes.filter((outcome) => outcome.outcome === "conflicted").map((outcome) => outcome.claim_id),
      superseded: outcomes.filter((outcome) => outcome.outcome === "superseded").map((outcome) => outcome.claim_id),
      stale: outcomes.filter((outcome) => outcome.outcome === "stale").map((outcome) => outcome.claim_id),
      review_required: outcomes.filter((outcome) => outcome.outcome === "review-required").map((outcome) => outcome.claim_id),
      context_pack_eligible: outcomes.filter((outcome) => outcome.context_pack_eligible).map((outcome) => outcome.claim_id),
      robust_context_pack_eligible: outcomes.filter((outcome) => outcome.continuity_state === "robust" && outcome.context_pack_eligible).map((outcome) => outcome.claim_id),
      history_only: outcomes.filter((outcome) => outcome.continuity?.history_only).map((outcome) => outcome.claim_id),
    },
    governed_controls: governedControls,
    risk_gate: riskGate,
    summary: {
      claims: outcomes.length,
      accepted: outcomes.filter((outcome) => outcome.outcome === "accepted").length,
      scratch: outcomes.filter((outcome) => outcome.outcome === "scratch").length,
      candidate: outcomes.filter((outcome) => outcome.outcome === "candidate").length,
      rejected: outcomes.filter((outcome) => outcome.outcome === "rejected").length,
      conflicted: outcomes.filter((outcome) => outcome.outcome === "conflicted").length,
      superseded: outcomes.filter((outcome) => outcome.outcome === "superseded").length,
      stale: outcomes.filter((outcome) => outcome.outcome === "stale").length,
      review_required: outcomes.filter((outcome) => outcome.outcome === "review-required").length,
      context_pack_eligible: outcomes.filter((outcome) => outcome.context_pack_eligible).length,
      risky_change_blocked: riskGate.blocked,
      governed_controls: governedControls.length,
    },
  };
}

function renderMarkdown(result) {
  const lines = ["# Knowledge Claim Compiler", ""];
  lines.push(`Claims: ${result.summary.claims}`);
  lines.push(`Accepted: ${result.summary.accepted}`);
  lines.push(`Review required: ${result.summary.review_required}`);
  lines.push(`Rejected: ${result.summary.rejected}`);
  lines.push("");
  for (const outcome of result.outcomes) {
    lines.push(`- ${outcome.claim_id || "(no id)"}: ${outcome.outcome} (${outcome.promotion_level}) — ${outcome.reasons.join(" ")}`);
  }
  return lines.join("\n");
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  if (parsed.error) {
    log(`knowledge-claim-compile: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: knowledge-claim-compile --input <claims.json> [--json] [--output <path>]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(path.resolve(cwd, parsed.options.input), "utf8"));
  } catch (error) {
    log(`knowledge-claim-compile: unable to read ${parsed.options.input}: ${error.message}`);
    return { code: 1 };
  }
  const result = compileClaims(payload);
  const body = parsed.options.json || parsed.options.output ? JSON.stringify(result, null, 2) : renderMarkdown(result);
  if (parsed.options.output) {
    const outputPath = path.resolve(cwd, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code: 0, result };
}

module.exports = {
  ARTIFACT_KIND,
  COMPILER_CONTRACT,
  CONTINUITY_LADDER,
  DEFAULT_POLICY,
  continuityStateFor,
  compileClaims,
  parseArgs,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
