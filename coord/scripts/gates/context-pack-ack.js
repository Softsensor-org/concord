"use strict";

const CONTEXT_PACK_ADVISORY_AUTHORITY_PATTERN =
  /\b(?:candidate|inferred|scratch|stale|private|rejected|conflicted|contradicted|superseded|advisory(?:-only)?)\b/i;
const CONTEXT_PACK_NONE_PATTERN = /^(?:none|not-required|n\/a)$/i;

function createContextPackAcknowledgementGate(deps) {
  const {
    isMeaningfulText,
    readBusinessContextEvidence,
    readBusinessContextPack,
    ticketRequiresAdrDecision,
    ticketTouchesBusinessContextRisk,
    toArray,
  } = deps;

  function collectContextPackAcknowledgementIssues(ticketId, row, planState) {
    if (!ticketRequiresContextPackAcknowledgement(row, planState)) {
      return [];
    }
    const ack = planState?.context_pack_ack;
    if (!ack || typeof ack !== "object" || Array.isArray(ack)) {
      return [{
        code: "context_pack_ack",
        message: `Plan state for ${ticketId} must record a structured context_pack_ack before review, including active constraints, ADRs, business rules, conflicts, stale warnings, open questions, authority use, and closeout learning disposition.`,
        next_steps: [
          `Record context_pack_ack in the canonical plan record with refs, considered sections, authority constraints/advisory-only split, and closeout_learning disposition.`,
        ],
      }];
    }

    const issues = [];
    const considered = ack.considered && typeof ack.considered === "object" && !Array.isArray(ack.considered)
      ? ack.considered
      : {};
    const missingConsidered = [
      "active_constraints",
      "adrs",
      "business_rules",
      "conflicts",
      "stale_warnings",
      "open_questions",
    ].filter((key) => !contextAckValueMeaningful(considered[key]));
    if (missingConsidered.length > 0) {
      issues.push({
        code: "context_pack_ack_sections",
        message: `Plan state for ${ticketId} context_pack_ack must explicitly say which ${missingConsidered.join(", ")} were considered.`,
        next_steps: [
          "Complete context_pack_ack.considered for active_constraints, adrs, business_rules, conflicts, stale_warnings, and open_questions.",
        ],
      });
    }

    const packRefs = Array.from(new Set([
      ...toArray(ack.refs),
      ...readBusinessContextEvidence(planState).refs,
    ].map((value) => String(value || "").trim()).filter(Boolean)));
    const packSummaries = packRefs.map((ref) => ({ ref, pack: readBusinessContextPack(ref) }));
    const unreadable = packSummaries.find((entry) => !entry.pack.ok);
    if (unreadable) {
      issues.push({
        code: "context_pack_ack_ref",
        message: `Plan state for ${ticketId} context_pack_ack references ${unreadable.ref}, but it could not be read: ${unreadable.pack.error}.`,
        next_steps: [`coord/scripts/coord business-context-pack --ticket ${ticketId} --write-default`],
      });
    }

    const mandatory = {
      conflicts: packSectionCount(packSummaries, "conflicts"),
      stale_warnings: packSectionCount(packSummaries, "stale_sources"),
      open_questions: packSectionCount(packSummaries, "open_questions"),
    };
    const mishandled = Object.entries(mandatory)
      .filter(([key, count]) => count > 0 && contextAckValueIsNone(considered[key]))
      .map(([key]) => key);
    if (mishandled.length > 0) {
      issues.push({
        code: "context_pack_ack_mandatory_sections",
        message: `Plan state for ${ticketId} context_pack_ack marks mandatory section(s) ${mishandled.join(", ")} as none even though the context pack contains matching items.`,
        next_steps: [
          "Update context_pack_ack.considered with handled conflict, stale-warning, and open-question details.",
        ],
      });
    }

    const authorityConstraints = toArray(ack.authority?.constraints);
    const advisoryUsedAsAuthority = authorityConstraints
      .filter((entry) => CONTEXT_PACK_ADVISORY_AUTHORITY_PATTERN.test(String(entry || "")));
    const packAdvisoryIds = advisoryPackItemIds(packSummaries);
    const advisoryIdSet = new Set(packAdvisoryIds.map((id) => String(id).toLowerCase()));
    const advisoryIdsUsedAsAuthority = authorityConstraints
      .map((entry) => String(entry || "").trim())
      .filter((entry) => advisoryIdSet.has(entry.toLowerCase()));
    if (advisoryUsedAsAuthority.length > 0 || advisoryIdsUsedAsAuthority.length > 0) {
      issues.push({
        code: "context_pack_advisory_authority",
        message: `Plan state for ${ticketId} uses advisory, stale, private, rejected, inferred, or conflicted memory as implementation authority. Advisory memory may be cited only as advisory context or investigation input.`,
        next_steps: [
          "Move advisory, stale, private, rejected, inferred, or conflicted entries from context_pack_ack.authority.constraints to authority.advisory_only.",
        ],
      });
    }

    const closeout = ack.closeout_learning && typeof ack.closeout_learning === "object" && !Array.isArray(ack.closeout_learning)
      ? ack.closeout_learning
      : {};
    const closeoutDecision = String(closeout.decision || "").trim();
    const hasLearningBucket =
      toArray(closeout.promote).some(isMeaningfulText) ||
      toArray(closeout.demote).some(isMeaningfulText) ||
      toArray(closeout.scratch_only).some(isMeaningfulText);
    if (!closeoutDecision && !hasLearningBucket) {
      issues.push({
        code: "context_pack_closeout_learning",
        message: `Plan state for ${ticketId} context_pack_ack must record whether new learning should be promoted, demoted, or left scratch-only before closeout.`,
        next_steps: [
          "Set context_pack_ack.closeout_learning.decision to promote, demote, scratch-only, mixed, or none.",
        ],
      });
    }

    return issues;
  }

  function ticketRequiresContextPackAcknowledgement(row, planState) {
    const evidence = readBusinessContextEvidence(planState);
    return (
      evidence.hasContextRef ||
      ticketTouchesBusinessContextRisk(row, planState) ||
      ticketRequiresAdrDecision(row, planState) ||
      Boolean(planState?.live_mcp) ||
      Boolean(planState?.bootstrap_risk)
    );
  }

  function contextAckValueMeaningful(value) {
    if (Array.isArray(value)) return value.some(isMeaningfulText);
    return isMeaningfulText(value);
  }

  function contextAckValueIsNone(value) {
    const values = Array.isArray(value) ? value : [value];
    const meaningful = values.map((entry) => String(entry || "").trim()).filter(Boolean);
    return meaningful.length > 0 && meaningful.every((entry) => CONTEXT_PACK_NONE_PATTERN.test(entry));
  }

  function packSectionCount(packSummaries, sectionName) {
    return packSummaries.reduce((total, entry) => {
      if (!entry.pack.ok) return total;
      const items = entry.pack.value?.sections?.[sectionName]?.items;
      return total + (Array.isArray(items) ? items.length : 0);
    }, 0);
  }

  function advisoryPackItemIds(packSummaries) {
    const advisorySections = ["conflicts", "stale_sources", "open_questions", "history", "adr_history"];
    const ids = [];
    for (const entry of packSummaries) {
      if (!entry.pack.ok) continue;
      for (const sectionName of advisorySections) {
        for (const item of entry.pack.value?.sections?.[sectionName]?.items || []) {
          const id = item?.id || item?.record_id || item?.source_record_id;
          if (id) ids.push(String(id));
        }
      }
      for (const item of entry.pack.value?.proposed_ticket_recommendations || []) {
        if (item?.source_record_id) ids.push(String(item.source_record_id));
      }
    }
    return Array.from(new Set(ids));
  }

  return {
    advisoryPackItemIds,
    collectContextPackAcknowledgementIssues,
    contextAckValueIsNone,
    contextAckValueMeaningful,
    packSectionCount,
    ticketRequiresContextPackAcknowledgement,
  };
}

module.exports = {
  createContextPackAcknowledgementGate,
};
