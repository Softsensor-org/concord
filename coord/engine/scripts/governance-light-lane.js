"use strict";

const LIGHT_LANE_TICKET_TYPES = new Set(["docs", "chore"]);

// Reference-doc tickets may use reduced plan evidence. Procedural documents
// change agent behavior and retain the full review lane. Ownership and other
// integrity gates are independent of this plan-completeness decision.
function createGovernanceLightLane({ splitPlanPathValues, isMeaningfulText }) {
  function isProceduralDocPath(value) {
    const normalized = String(value || "").trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized) {
      return false;
    }
    if (normalized === ".claude" || normalized.startsWith(".claude/") || normalized.includes("/.claude/")) {
      return true;
    }
    const base = normalized.split("/").pop();
    if (base === "AGENTS.md" || base === "CLAUDE.md") {
      return true;
    }
    if (normalized === "coord/GOVERNANCE.md" || base === "GOVERNANCE.md") {
      return true;
    }
    return false;
  }

  function isLightLaneEligible(ticket, changedPaths) {
    const type = String(ticket?.Type || ticket?.type || "").trim().toLowerCase();
    if (!LIGHT_LANE_TICKET_TYPES.has(type)) {
      return { eligible: false, reason: `ticket type "${type || "(none)"}" is not light-lane eligible (only docs/chore qualify)` };
    }
    const paths = (Array.isArray(changedPaths) ? changedPaths : [])
      .map((value) => String(value || "").trim())
      .filter((value) => isMeaningfulText(value));
    if (paths.length === 0) {
      return { eligible: false, reason: "no changed/intended paths recorded — cannot prove a reference-doc-only change, defaulting to full lane" };
    }
    const proceduralHits = paths.filter((value) => isProceduralDocPath(value));
    if (proceduralHits.length > 0) {
      return {
        eligible: false,
        reason: `changed paths touch procedural-doc surface(s) that change agent behavior (${proceduralHits.join(", ")}); full reviewed lane required`,
      };
    }
    return { eligible: true, reason: `docs/chore reference-doc change with no procedural-doc surfaces (${paths.join(", ")})` };
  }

  function resolveTicketLightLane(ticketId, row, planState) {
    // splitPlanPathValues returns only nonempty strings. The normalization
    // retains backtick, separator and relative-prefix handling for those paths.
    const intendedFiles = splitPlanPathValues(planState?.intended_files || [])
      .map((value) => String(value).trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/^\.\//, ""))
      .filter((value) => isMeaningfulText(value));
    return isLightLaneEligible(row, intendedFiles);
  }

  return { isProceduralDocPath, isLightLaneEligible, resolveTicketLightLane };
}

module.exports = { createGovernanceLightLane };
