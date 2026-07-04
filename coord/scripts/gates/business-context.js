"use strict";

const BUSINESS_CONTEXT_RISK_PATTERN =
  /\b(business rule|business rules|schema meaning|workflow|workflows|report|reports|downstream contract|downstream contracts|integration|integrations|workaround|workarounds|tax|billing|invoice|payment|ledger|approval|tenant|customer-specific|regulated|compliance|erp|pos|manufacturing|clinical|patient|menu|pricing|permission|permissions)\b/i;
const BUSINESS_CONTEXT_REF_PATTERN =
  /\b(?:business-context(?:-pack)?|context-pack)\s*:\s*([^\s,;]+)/ig;
const BUSINESS_CONTEXT_PATH_PATTERN =
  /\b(?:coord\/)?\.runtime\/context-packs\/[A-Za-z0-9_.-]+\.json\b/g;
const BUSINESS_CONTEXT_APPROVAL_PATTERN =
  /\bbusiness-context\s+(?:approval|approved|waiver|waived)\s*:/i;
const BUSINESS_CONTEXT_INVESTIGATION_PATTERN =
  /\bbusiness-context\s+(?:investigation|status)\s*:\s*(?:investigating|investigated|not-required|unknown|blocked|pending)/i;

function createBusinessContextGate(deps) {
  const {
    COORD_DIR,
    STATUS,
    fs,
    getRows,
    isMeaningfulText,
    path,
  } = deps;

  function collectBusinessContextGateIssues(ticketId, row, planState, board) {
    if (!ticketTouchesBusinessContextRisk(row, planState)) {
      return [];
    }

    const evidence = readBusinessContextEvidence(planState);
    if (!evidence.hasContextRef && !evidence.hasApprovalOrWaiver && !evidence.hasInvestigationStatus) {
      return [{
        code: "business_context_gate",
        message:
          `Ticket ${ticketId} changes behavior in a business-context-sensitive area but has no business-context ref, approval/waiver, or investigation status.`,
        next_steps: [
          `coord/scripts/coord business-context-pack --ticket ${ticketId} --write-default`,
          `coord/scripts/gov update-plan ${ticketId} --invariant "business-context: coord/.runtime/context-packs/${ticketId}.json"`,
          `coord/scripts/gov update-plan ${ticketId} --invariant "business-context investigation: <owner/status>"`,
        ],
      }];
    }

    const hasDisposition = evidence.hasApprovalOrWaiver || evidence.hasInvestigationStatus;
    const issues = [];
    for (const ref of evidence.refs) {
      const pack = readBusinessContextPack(ref);
      if (!pack.ok) {
        issues.push({
          code: "business_context_pack",
          message: `Ticket ${ticketId} references business context pack ${ref}, but it could not be read: ${pack.error}.`,
          next_steps: [
            `coord/scripts/coord business-context-pack --ticket ${ticketId} --write-default`,
          ],
        });
        continue;
      }
      if (hasDisposition) {
        continue;
      }
      const recommendations = Array.isArray(pack.value?.proposed_ticket_recommendations)
        ? pack.value.proposed_ticket_recommendations
        : [];
      issues.push(...collectBusinessContextProposalIssues(ticketId, recommendations, board));
    }
    return issues;
  }

  function ticketTouchesBusinessContextRisk(row, planState) {
    const text = [
      row?.Description,
      row?.Type,
      ...(planState?.intended_files || []),
      ...(planState?.change_summary || []),
      ...(planState?.critical_invariants || []),
      ...(planState?.requirement_closure || []),
    ].join("\n");
    return BUSINESS_CONTEXT_RISK_PATTERN.test(text);
  }

  function readBusinessContextEvidence(planState) {
    const text = [
      ...(planState?.intended_files || []),
      ...(planState?.change_summary || []),
      ...(planState?.verification_commands || []),
      ...(planState?.critical_invariants || []),
      ...(planState?.requirement_closure || []),
      ...(planState?.feature_proof || []),
      ...(planState?.repo_gates || []),
      JSON.stringify(planState?.context_pack_ack || {}),
    ].join("\n");
    const refs = [];
    for (const match of text.matchAll(BUSINESS_CONTEXT_REF_PATTERN)) {
      refs.push(match[1]);
    }
    for (const match of text.matchAll(BUSINESS_CONTEXT_PATH_PATTERN)) {
      refs.push(match[0].startsWith("coord/") ? match[0] : `coord/${match[0]}`);
    }
    return {
      refs: Array.from(new Set(refs)),
      hasContextRef: refs.length > 0,
      hasApprovalOrWaiver: BUSINESS_CONTEXT_APPROVAL_PATTERN.test(text),
      hasInvestigationStatus: BUSINESS_CONTEXT_INVESTIGATION_PATTERN.test(text),
    };
  }

  function readBusinessContextPack(ref) {
    const resolved = resolveBusinessContextRef(ref);
    try {
      return { ok: true, value: JSON.parse(fs.readFileSync(resolved, "utf8")) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  function resolveBusinessContextRef(ref) {
    const value = String(ref || "").trim();
    if (path.isAbsolute(value)) return value;
    const repoRoot = path.dirname(COORD_DIR);
    if (value.startsWith("coord/")) return path.join(repoRoot, value);
    return path.join(repoRoot, "coord", value);
  }

  function collectBusinessContextProposalIssues(ticketId, recommendations, board) {
    const issues = [];
    const rows = getRows(board);
    for (const recommendation of recommendations) {
      const sourceRecordId = String(recommendation?.source_record_id || "").trim();
      if (!sourceRecordId) {
        continue;
      }
      const matchingRows = rows.filter((candidate) => {
        if (candidate.ID === ticketId) return false;
        return String(candidate.Description || "").includes(sourceRecordId);
      });
      if (matchingRows.some((candidate) => candidate.Status === STATUS.TODO)) {
        issues.push({
          code: "business_context_proposed_intake",
          message: `Business-context finding ${sourceRecordId} is filed as todo, but uncertain/contradicted findings must enter proposed intake first.`,
          next_steps: [
            `coord/scripts/gov reject <todo-ticket> --reason "business-context finding must be re-filed as proposed"`,
            `coord/scripts/gov file-ticket --status proposed --repo ${recommendation.repo || "X"} --type ${recommendation.suggested_type || "spike"} --pri ${recommendation.suggested_priority || "P2"} --description "${sourceRecordId}: ${String(recommendation.statement || "investigate uncertain business finding").replace(/"/g, "'")}"`,
          ],
        });
      } else if (!matchingRows.some((candidate) => candidate.Status === STATUS.PROPOSED)) {
        issues.push({
          code: "business_context_proposed_intake",
          message: `Business-context finding ${sourceRecordId} is uncertain or contradicted and must be filed as a proposed ticket before active work treats it as backlog.`,
          next_steps: [
            `coord/scripts/gov file-ticket --status proposed --repo ${recommendation.repo || "X"} --type ${recommendation.suggested_type || "spike"} --pri ${recommendation.suggested_priority || "P2"} --description "${sourceRecordId}: ${String(recommendation.statement || "investigate uncertain business finding").replace(/"/g, "'")}"`,
          ],
        });
      }
    }
    return issues;
  }

  return {
    collectBusinessContextGateIssues,
    collectBusinessContextProposalIssues,
    readBusinessContextEvidence,
    readBusinessContextPack,
    resolveBusinessContextRef,
    ticketTouchesBusinessContextRisk,
  };
}

module.exports = {
  createBusinessContextGate,
};
