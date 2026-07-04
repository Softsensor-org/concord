"use strict";

// COORD-160: ADVISORY-ONLY server-bootstrap / startup / backfill risk surfacing.
//
// This module is the P2 follow-up to COORD-159 (which added the optional
// `bootstrap_risk` object to plan records) and COORD-158
// (coord/product/SERVER_BOOTSTRAP_JOB_CONTRACT.md, the canonical vocabulary).
//
// CONTRACT — this is WARNING-FIRST and must NEVER block:
//   - It never fails a gate, never adds a start/submit blocker, never changes an
//     exit code, and never rejects a ticket. `gov explain` simply embeds the
//     advisory object it returns under `bootstrap_advisory` for the operator to
//     read. If `triggered` is false the advisory is inert.
//   - The hard requirement (COORD-160) is "no false-blocking harmless local
//     bootstrap". The heuristic is therefore deliberately CONSERVATIVE: when in
//     doubt it under-warns. It is better to miss a borderline server bootstrap
//     job than to nag a developer seeding local fixtures.
//
// HEURISTIC (documented so it can be tuned):
//   1. Scan the ticket Description plus the plan record's free-text fields
//      (change_summary, critical_invariants, requirement_closure) for
//      server-bootstrap work signals.
//   2. Signals are split into STRONG and WEAK:
//        STRONG — backfill, migration, replay, derived-data, fact-table,
//                 index-population, generated-data, runs-at-boot. These name
//                 deployed data-generation/startup work directly.
//        WEAK   — seed, startup. These are ambiguous: "seed local dev data" and
//                 "synchronous startup config check" are harmless; only count a
//                 weak signal when it is NOT qualified as local/dev/fixture/sample
//                 and is not the lone signal of its kind.
//   3. LOCAL SUPPRESSION — the advisory is suppressed entirely when:
//        - bootstrap_risk.startup_work_class === "local_bootstrap" (the author
//          has explicitly declared this is local), OR
//        - every matched signal is a WEAK signal that appears only in a clearly
//          local/dev/fixture context.
//   4. When triggered, list exactly which of the required evidence fields are
//      missing from bootstrap_risk:
//        - resource_envelope
//        - idempotency or checkpoint strategy (either satisfies this)
//        - verification_signal BEYOND mere readiness (a signal that is only
//          "/readyz" / "deploy success" / "server started" does NOT count, per
//          the contract's hard rules)
//        - rollback_or_disable
//        - observability_requirements
//      If bootstrap_risk already supplies all of them, the advisory does not
//      trigger (nothing is missing).

// Strong signals: presence alone indicates deployed server-bootstrap/data work.
const STRONG_SIGNAL_PATTERNS = [
  { key: "backfill", re: /\bback[\s-]?fill(?:s|ed|ing)?\b/i },
  { key: "migration", re: /\bmigrat(?:e|es|ed|ing|ion|ions)\b/i },
  { key: "replay", re: /\breplay(?:s|ed|ing)?\b/i },
  { key: "derived-data", re: /\bderived[\s-]?data\b/i },
  { key: "fact-table", re: /\bfact[\s-]?tables?\b/i },
  { key: "index-population", re: /\bindex[\s-]?population\b|\b(?:populat\w+)\s+(?:the\s+)?index\b/i },
  { key: "generated-data", re: /\bgenerated[\s-]?data\b/i },
  { key: "runs-at-boot", re: /\bruns?[\s-]?at[\s-]?boot\b|\bat[\s-]?boot\b/i },
];

// Weak signals: ambiguous; only count outside a clearly-local context.
const WEAK_SIGNAL_PATTERNS = [
  { key: "seed", re: /\bseed(?:s|ed|ing)?\b/i },
  { key: "startup", re: /\bstart[\s-]?up\b|\bon\s+startup\b|\bboot\b/i },
];

// Phrases that mark a clearly-harmless LOCAL bootstrap context. When a weak
// signal sits next to one of these (anywhere in the same scanned text) it is
// treated as local and does not contribute a trigger.
const LOCAL_CONTEXT_RE =
  /\blocal\b|\bdev(?:elopment)?\b|\bfixtures?\b|\bsample\b|\bseed[\s-]?data\b|\bdemo\b|\bmock\b/i;

// A verification_signal made ONLY of these does not count as "beyond readiness".
const READINESS_ONLY_RE =
  /^[\s,/&-]*(?:\/?readyz|\/?healthz|ready|readiness|deploy(?:ed|ment)?\s*success|server\s*started|started)[\s,/&-]*$/i;

function normalizeText(value) {
  return String(value == null ? "" : value);
}

function collectScanText(row, planState) {
  const parts = [normalizeText(row && row.Description)];
  if (planState && typeof planState === "object") {
    for (const field of ["change_summary", "critical_invariants", "requirement_closure"]) {
      const values = planState[field];
      if (Array.isArray(values)) {
        for (const entry of values) {
          parts.push(normalizeText(entry));
        }
      }
    }
  }
  return parts.filter(Boolean).join("\n");
}

function isMeaningfulString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// verification_signal counts only when it names something beyond readiness/deploy.
function hasVerificationBeyondReadiness(bootstrapRisk) {
  const signal = bootstrapRisk && bootstrapRisk.verification_signal;
  if (!isMeaningfulString(signal)) {
    return false;
  }
  return !READINESS_ONLY_RE.test(signal.trim());
}

function hasResourceEnvelope(bootstrapRisk) {
  const envelope = bootstrapRisk && bootstrapRisk.resource_envelope;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return false;
  }
  // Any populated field counts as a declared envelope.
  return Object.values(envelope).some(
    (value) => value !== null && value !== undefined && String(value).trim() !== ""
  );
}

function hasIdempotencyOrCheckpoint(bootstrapRisk) {
  return (
    isMeaningfulString(bootstrapRisk && bootstrapRisk.idempotency_strategy) ||
    isMeaningfulString(bootstrapRisk && bootstrapRisk.checkpoint_strategy)
  );
}

function hasObservability(bootstrapRisk) {
  const obs = bootstrapRisk && bootstrapRisk.observability_requirements;
  return Array.isArray(obs) && obs.some((entry) => isMeaningfulString(entry));
}

function hasRollbackOrDisable(bootstrapRisk) {
  return isMeaningfulString(bootstrapRisk && bootstrapRisk.rollback_or_disable);
}

// Returns the ordered list of required-evidence fields that are missing.
function collectMissingEvidence(bootstrapRisk) {
  const missing = [];
  if (!hasResourceEnvelope(bootstrapRisk)) {
    missing.push("resource_envelope");
  }
  if (!hasIdempotencyOrCheckpoint(bootstrapRisk)) {
    missing.push("idempotency_or_checkpoint_strategy");
  }
  if (!hasVerificationBeyondReadiness(bootstrapRisk)) {
    missing.push("verification_signal_beyond_readiness");
  }
  if (!hasRollbackOrDisable(bootstrapRisk)) {
    missing.push("rollback_or_disable");
  }
  if (!hasObservability(bootstrapRisk)) {
    missing.push("observability_requirements");
  }
  return missing;
}

// The non-triggered, inert advisory shape. Always the same keys so consumers
// (gov explain JSON) get a stable contract.
function inertAdvisory(extra = {}) {
  return {
    triggered: false,
    blocking: false,
    matched_signals: [],
    missing_evidence: [],
    message: null,
    ...extra,
  };
}

// buildBootstrapAdvisory — pure. Given a board row and the parsed plan state,
// return the advisory object. NEVER throws on bad input and NEVER blocks; the
// `blocking: false` field is a load-bearing contract assertion that downstream
// readiness logic can rely on.
function buildBootstrapAdvisory({ row, planState } = {}) {
  const bootstrapRisk =
    planState && typeof planState.bootstrap_risk === "object" && !Array.isArray(planState.bootstrap_risk)
      ? planState.bootstrap_risk
      : null;

  // Explicit author declaration of LOCAL bootstrap suppresses everything.
  if (bootstrapRisk && bootstrapRisk.startup_work_class === "local_bootstrap") {
    return inertAdvisory({ suppressed_reason: "declared_local_bootstrap" });
  }

  const text = collectScanText(row, planState);
  if (!text.trim()) {
    return inertAdvisory();
  }
  const isLocalContext = LOCAL_CONTEXT_RE.test(text);

  const matchedSignals = [];
  for (const { key, re } of STRONG_SIGNAL_PATTERNS) {
    if (re.test(text)) {
      matchedSignals.push(key);
    }
  }
  // Weak signals only count when the surrounding text is NOT a clearly-local
  // context — this is the false-positive guard for "seed local dev data" etc.
  if (!isLocalContext) {
    for (const { key, re } of WEAK_SIGNAL_PATTERNS) {
      if (re.test(text)) {
        matchedSignals.push(key);
      }
    }
  }

  if (matchedSignals.length === 0) {
    return inertAdvisory(isLocalContext ? { suppressed_reason: "local_context_weak_signals_only" } : {});
  }

  const missingEvidence = collectMissingEvidence(bootstrapRisk);
  if (missingEvidence.length === 0) {
    // Signals present but the author already supplied complete bootstrap_risk
    // evidence — nothing to advise.
    return inertAdvisory({ matched_signals: matchedSignals });
  }

  const message =
    `This ticket mentions server-bootstrap / startup / data-generation work ` +
    `(${matchedSignals.join(", ")}) but its plan record is missing bootstrap_risk evidence: ` +
    `${missingEvidence.join(", ")}. ` +
    `Advisory only (non-blocking): if this is a deployed server bootstrap job, record the ` +
    `missing fields under bootstrap_risk (see coord/product/SERVER_BOOTSTRAP_JOB_CONTRACT.md). ` +
    `If this is harmless local bootstrap, set bootstrap_risk.startup_work_class=local_bootstrap to silence this.`;

  return {
    triggered: true,
    blocking: false,
    matched_signals: matchedSignals,
    missing_evidence: missingEvidence,
    message,
  };
}

module.exports = {
  buildBootstrapAdvisory,
  // exported for unit tests / reuse
  collectMissingEvidence,
  hasVerificationBeyondReadiness,
  STRONG_SIGNAL_PATTERNS,
  WEAK_SIGNAL_PATTERNS,
};
