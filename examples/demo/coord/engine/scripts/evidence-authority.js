"use strict";

const CONFIDENCE = new Set(["confirmed", "observed", "inferred", "hypothesis", "contradicted", "unknown", "deprecated", "waived"]);
const STATUS = new Set(["scratch", "candidate", "accepted", "rejected", "superseded", "stale", "deprecated", "waived"]);
const INTENT_AUTHORITIES = new Set(["approved_policy", "accepted_decision", "requirement", "review_comment"]);
const ENFORCEMENT_AUTHORITIES = new Set(["test_proof", "implementation", "runtime_observation"]);
const BLOCKED_CONFIDENCE = new Set(["inferred", "hypothesis", "contradicted", "unknown", "deprecated"]);
const BLOCKED_STATUS = new Set(["scratch", "candidate", "rejected", "superseded", "stale", "deprecated"]);
const SENSITIVE_VISIBILITY = new Set(["sensitive", "secret_prohibited"]);
const AUTHORITY_SCORE = new Map([
  ["approved_policy", 35],
  ["accepted_decision", 32],
  ["requirement", 28],
  ["review_comment", 22],
  ["test_proof", 20],
  ["runtime_observation", 16],
  ["implementation", 12],
  ["legacy_note", 6],
  ["summary", 0],
]);

function normalizeConfidence(value) {
  const confidence = String(value || "unknown").trim();
  return CONFIDENCE.has(confidence) ? confidence : "unknown";
}

function normalizeStatus(value) {
  const status = String(value || "candidate").trim();
  return STATUS.has(status) ? status : "candidate";
}

function classifySource({ authority = "implementation", visibility = "internal", sourceHash = null, commit = null } = {}) {
  const normalizedAuthority = String(authority || "implementation").trim();
  const normalizedVisibility = String(visibility || "internal").trim();
  const freshness = sourceHash || commit ? "current" : "unknown";
  return {
    authority_class: normalizedAuthority,
    freshness,
    sensitivity: normalizedVisibility,
  };
}

function normalizeSources(sources = []) {
  return (sources || []).map((source) => ({
    ...source,
    authority: String(source.authority || source.authority_class || source.evidence_role || "unknown").trim(),
    visibility: String(source.visibility || source.sensitivity || "internal").trim(),
    freshness: String(source.freshness || (source.source_hash || source.commit ? "current" : "unknown")).trim(),
  }));
}

function hasIntentAuthority(sources) {
  return sources.some((source) => INTENT_AUTHORITIES.has(source.authority));
}

function hasEnforcementAuthority(sources) {
  return sources.some((source) => ENFORCEMENT_AUTHORITIES.has(source.authority));
}

function isFreshnessStale(source) {
  return source.freshness === "stale" || source.source_hash_status === "stale" || source.hash_status === "stale" || source.source_changed === true || source.source_missing === true;
}

function reviewStatusFor(record = {}) {
  if (record.reviewer_approved === true || record.human_approved === true || record.review?.status === "approved") return "approved";
  if (record.deterministic_verified === true || record.machine_verified === true || record.review?.status === "machine_verified") return "machine_verified";
  if (normalizeStatus(record.status) === "accepted") return "accepted";
  if (normalizeStatus(record.status) === "waived" || record.waiver || record.review?.status === "waived") return "waived";
  if (normalizeStatus(record.status) === "rejected" || record.review?.status === "rejected") return "rejected";
  return "pending";
}

function conflictStateFor(record = {}) {
  if (record.status === "contradicted" || record.confidence === "contradicted" || record.conflicted === true) return "conflicted";
  if (Array.isArray(record.conflicts_with) && record.conflicts_with.length > 0) return "conflicted";
  if (record.conflict_state === "conflicted") return "conflicted";
  return "clear";
}

function computedFreshness(sources) {
  if (sources.some(isFreshnessStale)) return "stale";
  if (sources.length > 0 && sources.every((source) => source.freshness === "current" || source.source_hash || source.commit)) return "current";
  return "unknown";
}

function computedSensitivity(sources) {
  if (sources.some((source) => source.visibility === "secret_prohibited")) return "secret_prohibited";
  if (sources.some((source) => source.visibility === "sensitive")) return "sensitive";
  if (sources.some((source) => source.visibility === "private_pointer_only")) return "private_pointer_only";
  if (sources.length > 0 && sources.every((source) => source.visibility === "public")) return "public";
  return "internal";
}

function verificationLevelFor(record, sources) {
  const reviewStatus = reviewStatusFor(record);
  if (reviewStatus === "approved") return "human_approved";
  if (record.deterministic_verified === true || record.machine_verified === true) return "machine_verified";
  if (hasIntentAuthority(sources) && hasEnforcementAuthority(sources)) return "intent_and_enforcement";
  if (hasIntentAuthority(sources)) return "intent_only";
  if (hasEnforcementAuthority(sources)) return "observed_behavior";
  return "unverified";
}

function computeConfidence(record = {}, sources = []) {
  const normalizedSources = normalizeSources(sources);
  const normalizedStatus = normalizeStatus(record.status);
  const extractorConfidence = normalizeConfidence(record.confidence);
  const sourceAuthorities = Array.from(new Set(normalizedSources.map((source) => source.authority).filter(Boolean))).sort();
  const sourceAuthorityScore = normalizedSources.reduce((score, source) => Math.max(score, AUTHORITY_SCORE.get(source.authority) || 0), 0);
  const corroboratingSourceCount = sourceAuthorities.filter((authority) => authority !== "summary").length;
  const freshness = computedFreshness(normalizedSources);
  const sensitivity = computedSensitivity(normalizedSources);
  const reviewStatus = reviewStatusFor(record);
  const conflictState = conflictStateFor(record);
  const verificationLevel = verificationLevelFor(record, normalizedSources);

  let score = sourceAuthorityScore;
  score += Math.min(corroboratingSourceCount, 4) * 8;
  if (verificationLevel === "human_approved") score += 35;
  else if (verificationLevel === "machine_verified") score += 28;
  else if (verificationLevel === "intent_and_enforcement") score += 24;
  else if (verificationLevel === "intent_only") score += 14;
  else if (verificationLevel === "observed_behavior") score += 8;
  if (freshness === "current") score += 10;
  if (freshness === "unknown") score -= 5;
  if (freshness === "stale") score -= 40;
  if (conflictState === "conflicted") score -= 60;
  if (SENSITIVE_VISIBILITY.has(sensitivity)) score -= 10;
  if (reviewStatus === "rejected") score -= 40;
  score = Math.max(0, Math.min(100, score));

  let confidence = "unknown";
  if (normalizedStatus === "deprecated" || normalizedStatus === "superseded" || freshness === "stale") confidence = "deprecated";
  else if (normalizedStatus === "waived" || reviewStatus === "waived") confidence = "waived";
  else if (conflictState === "conflicted") confidence = "contradicted";
  else if (verificationLevel === "human_approved" && sourceAuthorityScore >= AUTHORITY_SCORE.get("requirement")) confidence = "confirmed";
  else if (verificationLevel === "machine_verified" && corroboratingSourceCount >= 2 && hasIntentAuthority(normalizedSources)) confidence = "confirmed";
  else if (verificationLevel === "intent_and_enforcement" && normalizedStatus === "accepted") confidence = "confirmed";
  else if (verificationLevel === "observed_behavior") confidence = "observed";
  else if (verificationLevel === "intent_only") confidence = "inferred";
  else if (extractorConfidence === "hypothesis") confidence = "hypothesis";

  return {
    confidence,
    score,
    inputs: {
      extractor_confidence: extractorConfidence,
      verification_level: verificationLevel,
      source_authority_score: sourceAuthorityScore,
      corroborating_source_count: corroboratingSourceCount,
      freshness,
      conflict_state: conflictState,
      sensitivity,
      review_status: reviewStatus,
      source_authorities: sourceAuthorities,
    },
  };
}

function deriveConfidence({ confidence, status, sources = [], record = {} } = {}) {
  const normalizedStatus = normalizeStatus(status);
  if (normalizedStatus === "deprecated") return "deprecated";
  if (normalizedStatus === "waived") return "waived";
  return computeConfidence({ ...record, confidence, status }, sources).confidence;
}

function classifyRecordAuthority(record = {}, sources = []) {
  const status = normalizeStatus(record.status);
  const computed = computeConfidence(record, sources);
  const confidence = computed.confidence;
  const sourceAuthorities = computed.inputs.source_authorities;
  const sensitivity = computed.inputs.sensitivity;
  const freshness = computed.inputs.freshness;

  let canGuideImplementation = false;
  let approvalRequired = true;
  let reason = "Discovery facts cannot guide implementation until accepted or waived by an authority.";

  if (status === "accepted" && confidence === "confirmed") {
    canGuideImplementation = true;
    approvalRequired = false;
    reason = "Accepted confirmed record can guide implementation.";
  } else if (status === "waived" || confidence === "waived") {
    canGuideImplementation = true;
    approvalRequired = false;
    reason = "Waiver allows this record to guide implementation despite incomplete confidence.";
  } else if (BLOCKED_STATUS.has(status)) {
    reason = `Record status ${status} cannot guide implementation.`;
  } else if (BLOCKED_CONFIDENCE.has(confidence)) {
    reason = `Record confidence ${confidence} requires approval or waiver before implementation authority.`;
  } else if (confidence === "observed") {
    reason = "Observed behavior is evidence, not proven business intent.";
  }

  return {
    confidence,
    computed_confidence: confidence,
    confidence_score: computed.score,
    confidence_inputs: computed.inputs,
    source_authorities: sourceAuthorities,
    freshness,
    sensitivity,
    can_guide_implementation: canGuideImplementation,
    approval_required: approvalRequired,
    reason,
  };
}

module.exports = {
  classifyRecordAuthority,
  classifySource,
  computeConfidence,
  deriveConfidence,
  normalizeConfidence,
  normalizeStatus,
};
