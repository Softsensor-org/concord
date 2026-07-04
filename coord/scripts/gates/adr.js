"use strict";

const ADR_REQUIRED_RISK_PATTERN =
  /\b(governance policy|governance policies|authn|authz|auth|rbac|permission|permissions|schema semantic|schema semantics|data model|public api|public apis|api contract|cross-repo contract|cross repo contract|security boundary|security\/trust|trust boundary|key management|signing|kms|tenant isolation|deliberate deferral|deferred decision|waiver|memory authority|knowledge authority|agent operating protocol|business behavior|approval workflow|ledger|billing|invoice|payment|regulated)\b/i;
const ADR_DISCOVERY_STATUS_PATTERN =
  /\b(?:adr|decision)\s+(?:status|investigation)\s*:\s*(?:investigating|investigation|discovery|not-required|not required|pending)\b/i;

function createAdrGate(deps) {
  const {
    COORD_DIR,
    escapeRegex,
    path,
    validateAdrRegistry,
  } = deps;

  function collectAdrRequirementIssues(ticketId, row, planState) {
    const guidance = deriveDecisionRequiredGuidance(ticketId, row, planState);
    if (!guidance.required || guidance.satisfied) {
      return [];
    }
    return [{
      code: "adr_required",
      message: `Ticket ${ticketId} appears to require an ADR because ${guidance.reason}; add an accepted ADR ref, explicit waiver, or investigation/discovery status before review.`,
      next_steps: [
        `coord/scripts/gov adr new --title "<decision title>" --ticket ${ticketId}`,
        `coord/scripts/gov adr link ${ticketId} <adr-id>`,
        `coord/scripts/gov update-plan ${ticketId} --invariant "decision status: investigating <owner/reason>"`,
      ],
    }];
  }

  function collectAdrReviewCycleIssues(ticketId, row, planState, cycles = []) {
    const guidance = deriveDecisionRequiredGuidance(ticketId, row, planState);
    const evidence = readAdrDecisionEvidence(planState);
    const registry = readAcceptedAdrRegistry();
    const referencedAdrs = evidence.adr_refs
      .map((ref) => registry.byId.get(normalizeAdrRef(ref)))
      .filter(Boolean);
    const adrRelevant = guidance.required || evidence.adr_refs.length > 0;
    if (!adrRelevant) {
      return [];
    }

    // COORD-430: fail CLOSED when the ADR registry could not be read/parsed. The
    // catch in readAcceptedAdrRegistry yields an empty byId, which would otherwise
    // let the `!referencedAdrs.some(...)` checks below pass vacuously — silently
    // defeating ADR-compliance verification on an unrelated I/O error. If ADRs are
    // relevant to this ticket, block until the registry is readable.
    if (registry.readError) {
      return [{
        code: "adr_registry_unreadable",
        message: `Cannot verify ADR-compliance evidence for ${ticketId}: the ADR registry (coord/docs/decisions) could not be read${registry.error ? ` (${registry.error})` : ""}. ADR-aware review must not pass fail-open.`,
        next_steps: [
          `coord/scripts/coord adr-validate --json   # inspect the registry read error`,
          `# restore/repair coord/docs/decisions, then re-run the gate`,
        ],
      }];
    }

    const text = cycles.map((cycle) => [
      cycle.raw,
      cycle.lens,
      cycle.diff,
      ...(cycle.risks || []),
      cycle.findings,
      cycle.verification,
      cycle.verdict,
    ].join("\n")).join("\n");
    const answers = {
      followsAccepted: !referencedAdrs.some((adr) => adr.status === "Accepted") || /\bADR[-\s:]?\d{4}\b[\s\S]{0,160}\b(follow|follows|followed|comply|complies|compliant|align|aligned|conform|satisfy|satisfies|satisfied|waiv(?:e|ed|er))\b/i.test(text) || /\b(follow|follows|followed|comply|complies|compliant|align|aligned|conform|satisfy|satisfies|satisfied|waiv(?:e|ed|er))\b[\s\S]{0,160}\bADR[-\s:]?\d{4}\b/i.test(text),
      rejectedAlternatives: !referencedAdrs.some(adrHasRejectedAlternatives) || /\b(rejected alternative|alternatives rejected|violat(?:e|es|ed|ion).{0,80}rejected|no rejected alternative|does not violate rejected)\b/i.test(text),
      revisitTrigger: !referencedAdrs.some(adrHasRevisitTrigger) || /\b(revisit trigger|trigger(?:s|ed)? revisit|revisit.{0,80}(not triggered|not met|unchanged|no)|no revisit)\b/i.test(text),
      newAdr: !guidance.required || /\b(new ADR|new decision record|needs? an ADR|ADR required|ADR not required|no new ADR|waiver)\b/i.test(text),
    };
    const missing = Object.entries(answers)
      .filter(([, ok]) => !ok)
      .map(([key]) => key);
    if (missing.length === 0) {
      return [];
    }
    return [{
      code: "adr_review_cycle",
      message: `Plan state for ${ticketId} must include ADR-aware self-review evidence before review: ${formatAdrReviewMissingAnswers(missing)}.`,
      next_steps: [
        `coord/scripts/gov update-plan ${ticketId} --review-cycle "lens=ADR compliance; diff=<changed decision surface>; risks=<ADR drift>, <rejected alternative regression>; findings=ADR compliance: <follows/waived>; rejected alternatives: <none|details>; revisit trigger: <not triggered|details>; new ADR: <not required|required>; verification=<command>; verdict=<pass|fail>"`,
      ],
    }];
  }

  function collectAdrCloseoutCitationIssues(ticketId, row, planState) {
    const guidance = deriveDecisionRequiredGuidance(ticketId, row, planState);
    if (!guidance.required || !guidance.satisfied || guidance.investigation) {
      return [];
    }
    const closureText = [
      ...(planState?.requirement_closure || []),
      ...(planState?.critical_invariants || []),
      planState?.decision_required?.waiver,
    ].join("\n");
    const citesCompliance = guidance.accepted_adr_refs.some((id) => new RegExp(`\\bADR[-\\s:]?${escapeRegex(id)}\\b`, "i").test(closureText)) &&
      /\b(ADR|decision).{0,120}\b(compliance|compliant|follows|followed|aligned|satisfied)\b/i.test(closureText);
    const citesWaiver = guidance.waiver &&
      /\b(ADR|decision).{0,120}\b(waiver|waived)\b/i.test(closureText);
    if (citesCompliance || citesWaiver) {
      return [];
    }
    return [{
      code: "adr_closeout_citation",
      message: `Plan state for ${ticketId} must cite ADR compliance or a ticket-scoped ADR waiver in closeout evidence before review.`,
      next_steps: [
        `coord/scripts/gov update-plan ${ticketId} --closure "ADR compliance: follows ADR-<id> (<short evidence>)"`,
        `coord/scripts/gov update-plan ${ticketId} --closure "ADR waiver: <human-admin waiver / scope>"`,
      ],
    }];
  }

  function deriveDecisionRequiredGuidance(ticketId, row, planState) {
    const required = ticketRequiresAdrDecision(row, planState);
    const evidence = readAdrDecisionEvidence(planState);
    if (!required) {
      return {
        required: false,
        satisfied: true,
        reason: "no high-impact ADR trigger detected",
        adr_refs: evidence.adr_refs,
        accepted_adr_refs: [],
        missing_adr_refs: [],
        waiver: evidence.hasWaiver,
        investigation: evidence.hasInvestigationStatus,
      };
    }

    const registry = readAcceptedAdrRegistry();
    const accepted = [];
    const missing = [];
    for (const ref of evidence.adr_refs) {
      const id = normalizeAdrRef(ref);
      if (!id) {
        missing.push(ref);
        continue;
      }
      const adr = registry.byId.get(id);
      if (adr?.status === "Accepted") {
        accepted.push(id);
      } else {
        missing.push(ref);
      }
    }
    const satisfied = accepted.length > 0 || evidence.hasWaiver || evidence.hasInvestigationStatus;
    return {
      required: true,
      satisfied,
      reason: resolveAdrRequiredReason(row, planState),
      adr_refs: evidence.adr_refs,
      accepted_adr_refs: accepted,
      missing_adr_refs: missing,
      waiver: evidence.hasWaiver,
      investigation: evidence.hasInvestigationStatus,
    };
  }

  function ticketRequiresAdrDecision(row, planState) {
    const declared = planState?.decision_required;
    if (declared && typeof declared === "object") {
      if (declared.required === true) return true;
      if (["required", "deferred"].includes(String(declared.status || ""))) return true;
      if (declared.required === false || ["not-required", "waived", "investigating"].includes(String(declared.status || ""))) {
        return false;
      }
    }
    const type = String(row?.Type || "").trim().toLowerCase();
    if (["bug", "docs", "test", "chore"].includes(type) && !ADR_REQUIRED_RISK_PATTERN.test(buildAdrRiskText(row, planState))) {
      return false;
    }
    return ADR_REQUIRED_RISK_PATTERN.test(buildAdrRiskText(row, planState));
  }

  function resolveAdrRequiredReason(row, planState) {
    const declared = planState?.decision_required;
    if (declared?.reason) {
      return String(declared.reason);
    }
    const text = buildAdrRiskText(row, planState);
    const match = text.match(ADR_REQUIRED_RISK_PATTERN);
    return match ? `it touches high-impact decision surface "${match[0]}"` : "it is marked decision_required";
  }

  function buildAdrRiskText(row, planState) {
    return [
      row?.Description,
      row?.Type,
      planState?.security_surface,
      ...(planState?.intended_files || []),
      ...(planState?.change_summary || []),
      ...(planState?.critical_invariants || []),
      ...(planState?.requirement_closure || []),
    ].join("\n");
  }

  function readAdrDecisionEvidence(planState) {
    const declared = planState?.decision_required && typeof planState.decision_required === "object"
      ? planState.decision_required
      : {};
    const text = [
      ...(planState?.adr_refs || []),
      ...(Array.isArray(declared.adr_refs) ? declared.adr_refs : []),
      declared.waiver,
      declared.status,
      declared.reason,
      ...(planState?.critical_invariants || []),
      ...(planState?.requirement_closure || []),
    ].join("\n");
    const inlineRefs = Array.from(text.matchAll(/\bADR[-\s:]?([0-9]{4})\b/gi)).map((match) => match[1]);
    const adrRefs = Array.from(new Set([
      ...(planState?.adr_refs || []),
      ...(Array.isArray(declared.adr_refs) ? declared.adr_refs : []),
      ...inlineRefs,
    ].map((value) => String(value || "").trim()).filter(Boolean)));
    return {
      adr_refs: adrRefs,
      hasWaiver: Boolean(declared.waiver) || /\b(?:adr|decision)\s+waiv(?:er|ed)\s*:/i.test(text),
      hasInvestigationStatus: ["investigating", "not-required"].includes(String(declared.status || "")) || ADR_DISCOVERY_STATUS_PATTERN.test(text),
    };
  }

  function adrHasRejectedAlternatives(adr) {
    return /\b##\s+Alternatives Rejected\b[\s\S]*?(?:\n##\s+|$)/i.test(adr?.raw || "") &&
      !/\b##\s+Alternatives Rejected\b\s*(?:\n\s*)*-\s*TBD\b/i.test(adr.raw || "");
  }

  function adrHasRevisitTrigger(adr) {
    return /\b##\s+Revisit Trigger\b[\s\S]*?(?:\n##\s+|$)/i.test(adr?.raw || "") &&
      !/\b##\s+Revisit Trigger\b\s*(?:\n\s*)*(?:TBD\.?|-\s*TBD\.?)\b/i.test(adr.raw || "");
  }

  function formatAdrReviewMissingAnswers(missing) {
    const labels = {
      followsAccepted: "whether linked accepted ADRs are followed",
      rejectedAlternatives: "whether rejected alternatives are violated",
      revisitTrigger: "whether revisit triggers are met",
      newAdr: "whether a new ADR is required",
    };
    return missing.map((key) => labels[key] || key).join("; ");
  }

  function normalizeAdrRef(value) {
    const match = String(value || "").match(/(?:ADR[-\s:]?)?([0-9]{4})\b/);
    return match ? match[1] : null;
  }

  function readAcceptedAdrRegistry() {
    const decisionsDir = path.join(path.dirname(COORD_DIR), "coord", "docs", "decisions");
    try {
      const report = validateAdrRegistry(decisionsDir);
      const byId = new Map((report.adrs || []).map((adr) => [adr.id, adr]));
      return { ok: report.summary?.ok === true, byId, readError: false };
    } catch (error) {
      // COORD-430: a genuine read/parse failure (NOT a missing dir — validateAdrRegistry
      // handles that gracefully) must be distinguishable from a valid-but-empty
      // registry, so ADR-aware review can fail CLOSED instead of passing vacuously
      // on an empty byId.
      return { ok: false, byId: new Map(), readError: true, error: error?.message };
    }
  }

  return {
    collectAdrCloseoutCitationIssues,
    collectAdrRequirementIssues,
    collectAdrReviewCycleIssues,
    deriveDecisionRequiredGuidance,
    normalizeAdrRef,
    readAdrDecisionEvidence,
    ticketRequiresAdrDecision,
  };
}

module.exports = {
  createAdrGate,
};
