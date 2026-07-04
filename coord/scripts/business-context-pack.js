#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const adrRegistry = require("./adr-validator.js");

const ARTIFACT_KIND = "concord.business_context_pack";
const DEFAULT_INPUT = "coord/.runtime/discovery/synthesis.json";
const DEFAULT_ADR_DIR = "coord/docs/decisions";
const READ_ONLY_CONTRACT = Object.freeze({
  ui_tier: "read_only",
  discovery_execution_allowed: false,
  file_mutation_allowed: false,
  mutation_path: "Context packs are derived from synthesis artifacts; cockpit/web surfaces render this data and do not run discovery or mutate files.",
});
const USAGE_ACK_CONTRACT = Object.freeze({
  plan_field: "context_pack_ack",
  required_for: [
    "context-sensitive behavior changes",
    "ADR/high-impact decision work",
    "tickets that cite a context pack",
    "live-MCP or bootstrap/backfill work",
  ],
  considered_sections: [
    "active_constraints",
    "adrs",
    "business_rules",
    "conflicts",
    "stale_warnings",
    "open_questions",
  ],
  authority_rule: "Only confirmed/current claims, accepted ADRs, requirements, schema/code contracts, or explicit waivers may govern implementation.",
  advisory_only: [
    "candidate",
    "inferred",
    "scratch",
    "stale",
    "private",
    "rejected",
    "conflicted",
    "contradicted",
    "superseded",
  ],
  mandatory_closeout_learning: "Closeout must record whether new learning should be promoted, demoted, or left scratch-only.",
});

const SECTION_KINDS = {
  facts: ["fact", "business_object", "configuration_surface"],
  workflows: ["workflow", "ux_behavior"],
  fields: ["field_rule"],
  contracts: ["integration_contract", "data_dependency"],
  workarounds: ["hypothesis", "reflection"],
  contradictions: ["contradiction"],
  decisions: ["decision"],
};

const UNCERTAIN_STATUSES = new Set(["candidate", "scratch", "stale", "deprecated"]);
const UNCERTAIN_BUCKETS = new Set(["contradicted", "stale", "inferred", "unknown"]);
const UNCERTAIN_CONFIDENCE = new Set(["inferred", "hypothesis", "contradicted", "unknown", "observed"]);

const SOURCE_AUTHORITY_RANK = Object.freeze({
  approved_policy: 100,
  accepted_decision: 90,
  requirement: 80,
  human_review_comment: 70,
  schema_contract: 65,
  code_contract: 60,
  test: 50,
  runtime_observation: 40,
  source_comment: 20,
  unknown: 0,
});

const RANK_CATEGORY_PRIORITY = Object.freeze({
  exact_subject_or_source_match: 100,
  confirmed_rule: 90,
  active_contradiction: 80,
  authoritative_decision: 70,
  schema_or_contract_lineage: 60,
  prior_incident: 50,
  preservation_test: 40,
  observed_context: 30,
  inferred_context: 20,
});

function parseArgs(argv = []) {
  const options = {
    input: DEFAULT_INPUT,
    ticket: null,
    scope: "",
    touchedFiles: [],
    requirements: [],
    json: false,
    output: null,
    outputMd: null,
    writeDefault: false,
    limit: 6,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--write-default") {
      options.writeDefault = true;
      options.json = true;
      continue;
    }
    if (["--input", "--ticket", "--scope", "--touched-file", "--requirement", "--output", "--output-md", "--limit"].includes(arg)) {
      const value = argv[++i];
      if (!value) return { error: `${arg} requires a value` };
      if (arg === "--touched-file") options.touchedFiles.push(value);
      else if (arg === "--requirement") options.requirements.push(value);
      else if (arg === "--limit") options.limit = Number(value);
      else options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  if (!options.ticket) return { error: "--ticket is required" };
  if (!Number.isInteger(options.limit) || options.limit < 1) return { error: "--limit must be a positive integer" };
  return { options };
}

function tokenize(value) {
  return Array.from(new Set(String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)));
}

function sourceById(synthesis) {
  const map = new Map();
  for (const node of synthesis.context_graph?.nodes || []) {
    if (node.type === "evidence") map.set(node.id, node);
  }
  return map;
}

function recordNodes(synthesis) {
  return (synthesis.context_graph?.nodes || []).filter((node) => node.id && node.id.startsWith("BD-REC-"));
}

function coldStartBaselineFor(synthesis, nodes) {
  if (synthesis.cold_start_baseline) return synthesis.cold_start_baseline;
  const confirmed = nodes.filter((node) => node.confidence === "confirmed" && (node.status === "accepted" || node.bucket === "accepted"));
  const observed = nodes.filter((node) => node.confidence === "observed" || node.bucket === "observed");
  const inferred = nodes.filter((node) => ["inferred", "hypothesis", "unknown"].includes(node.confidence) || ["inferred", "unknown"].includes(node.bucket));
  const unknowns = synthesis.unknowns || [];
  const preservationCandidates = synthesis.preservation_harness_candidates || [];
  return {
    status: confirmed.length === 0 ? "sparse_memory_baseline" : "partial_confirmed_baseline",
    sparse_memory: confirmed.length === 0,
    authority_warning: confirmed.length === 0
      ? "No accepted confirmed business-memory claims were available in the discovery synthesis. This context pack separates observed and inferred context from confirmed authority."
      : "Confirmed records are present, but observed and inferred context remains non-authoritative until promoted.",
    confirmed_authority: {
      accepted_confirmed_records: confirmed.length,
      may_claim_confirmed_memory: confirmed.length > 0,
    },
    coverage_gaps: [
      confirmed.length === 0 ? "confirmed_memory" : null,
      unknowns.length > 0 ? "open_questions_or_unknowns" : null,
      inferred.length > 0 ? "inferred_context_requires_review" : null,
      preservationCandidates.length === 0 ? "preservation_candidates" : null,
    ].filter(Boolean),
    counts: {
      confirmed: confirmed.length,
      observed: observed.length,
      inferred: inferred.length,
      unknowns: unknowns.length,
      preservation_candidates: preservationCandidates.length,
    },
  };
}

function evidenceFor(recordId, synthesis, sources) {
  return (synthesis.context_graph?.edges || [])
    .filter((edge) => edge.from === recordId && edge.type === "proven_by")
    .map((edge) => {
      const source = sources.get(edge.to);
      return {
        source_id: edge.to,
        label: source?.label || edge.to,
        authority: source?.authority || null,
        visibility: source?.visibility || null,
      };
    });
}

function docRecordMap(synthesis) {
  const byRecord = new Map();
  for (const doc of synthesis.promoted_docs || []) {
    for (const id of doc.record_ids || []) byRecord.set(id, doc.file);
  }
  return byRecord;
}

function scoreNode(node, queryTokens, touchedFiles) {
  const haystack = tokenize(`${node.id} ${node.label || ""} ${node.type || ""}`).join(" ");
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 5;
  }
  for (const file of touchedFiles) {
    const base = path.basename(file).toLowerCase();
    if (base && haystack.includes(base)) score += 8;
    if (file && haystack.includes(file.toLowerCase())) score += 12;
  }
  if (node.bucket === "accepted") score += 10;
  if (node.bucket === "contradicted") score += 9;
  if (node.bucket === "observed") score += 4;
  return score;
}

// COORD-366: relevance of a node to the ticket's CHANGE SURFACE only — content
// tokens (scope + requirement text) plus precise touched-file matches. Unlike
// scoreNode this adds NO bucket bonus, so an uncertain node anywhere in the
// repo-wide corpus does not become "relevant" just by being contradicted. Used to
// scope proposed-ticket recommendations to the ticket actually under work, instead
// of surfacing every uncertain finding in the corpus on a maintenance change.
function changeSurfaceRelevance(node, contentTokens, touchedFiles) {
  const haystack = tokenize(`${node.id} ${node.label || ""} ${node.type || ""}`).join(" ");
  let score = 0;
  for (const token of contentTokens) {
    if (haystack.includes(token)) score += 5;
  }
  for (const file of touchedFiles) {
    const base = path.basename(file).toLowerCase();
    if (base && haystack.includes(base)) score += 8;
    if (file && haystack.includes(file.toLowerCase())) score += 12;
  }
  return score;
}

function scoreText(value, queryTokens, touchedFiles) {
  const haystack = tokenize(value).join(" ");
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 5;
  }
  for (const file of touchedFiles) {
    const base = path.basename(file).toLowerCase();
    if (base && haystack.includes(base)) score += 8;
    if (file && haystack.includes(file.toLowerCase())) score += 12;
  }
  return score;
}

function bestSourceAuthority(evidence) {
  let best = "unknown";
  let bestRank = SOURCE_AUTHORITY_RANK.unknown;
  for (const item of evidence || []) {
    const authority = String(item.authority || "unknown");
    const rank = SOURCE_AUTHORITY_RANK[authority] ?? SOURCE_AUTHORITY_RANK.unknown;
    if (rank > bestRank || (rank === bestRank && authority.localeCompare(best) < 0)) {
      best = authority;
      bestRank = rank;
    }
  }
  return { authority: best, rank: bestRank };
}

function conflictStateFor(node) {
  if (isConflictedNode(node)) return "active_conflict";
  if (Array.isArray(node.conflicts_with) && node.conflicts_with.length > 0) return "references_conflict";
  return "none";
}

function stalenessFor(node) {
  if (isStaleNode(node)) return "stale";
  if (isSupersededNode(node)) return "superseded";
  return "fresh";
}

function rankCategoryFor(node, score, sourceAuthority) {
  if (isConflictedNode(node)) return "active_contradiction";
  if (isStaleNode(node) || isSupersededNode(node)) return "inferred_context";
  if (score >= 20 && !isUncertainNode(node)) return "exact_subject_or_source_match";
  if (node.type === "decision" || sourceAuthority === "accepted_decision") return "authoritative_decision";
  if (node.type === "integration_contract" || node.type === "data_dependency" || sourceAuthority === "schema_contract" || sourceAuthority === "code_contract") {
    return "schema_or_contract_lineage";
  }
  if (node.type === "incident" || node.type === "prior_incident") return "prior_incident";
  if (node.type === "preservation_test" || sourceAuthority === "test") return "preservation_test";
  if (node.status === "accepted" || node.status === "approved" || node.bucket === "accepted" || sourceAuthority === "approved_policy" || sourceAuthority === "requirement") {
    return "confirmed_rule";
  }
  if (node.bucket === "observed" || node.confidence === "observed") return "observed_context";
  return "inferred_context";
}

function computedConfidenceFor(node, sourceAuthorityRank) {
  if (isSupersededNode(node) || isStaleNode(node)) return "low";
  if (isConflictedNode(node)) return "medium";
  if ((node.status === "accepted" || node.status === "approved" || node.bucket === "accepted") && sourceAuthorityRank >= SOURCE_AUTHORITY_RANK.human_review_comment) {
    return "high";
  }
  if (node.confidence === "observed" || node.bucket === "observed" || sourceAuthorityRank >= SOURCE_AUTHORITY_RANK.test) {
    return "medium";
  }
  return "low";
}

function canGovernImplementation(node, rankCategory, computedConfidence) {
  return (
    computedConfidence === "high" &&
    !isConflictedNode(node) &&
    !isStaleNode(node) &&
    !isSupersededNode(node) &&
    ["confirmed_rule", "authoritative_decision", "schema_or_contract_lineage", "exact_subject_or_source_match"].includes(rankCategory)
  );
}

function decorateItem(item, node, score) {
  const source = bestSourceAuthority(item.evidence);
  const rankCategory = rankCategoryFor(node, score, source.authority);
  const computedConfidence = computedConfidenceFor(node, source.rank);
  return {
    ...item,
    status: item.status || node.status || node.bucket || "unknown",
    computed_confidence: computedConfidence,
    conflict_state: conflictStateFor(node),
    staleness: stalenessFor(node),
    source_authority: source.authority,
    can_govern_implementation: canGovernImplementation(node, rankCategory, computedConfidence),
    rank_category: rankCategory,
    rank_priority: RANK_CATEGORY_PRIORITY[rankCategory],
    match_score: score,
  };
}

function isSupersededNode(node) {
  return node.status === "superseded" || Boolean(node.superseded_by) || node.bucket === "superseded";
}

function isConflictedNode(node) {
  return node.status === "conflicted" || node.bucket === "contradicted" || node.type === "contradiction" || (Array.isArray(node.conflicts_with) && node.conflicts_with.length > 0);
}

function isStaleNode(node) {
  return node.status === "stale" || node.stale === true || node.bucket === "stale";
}

function isActivePackNode(node) {
  return !isSupersededNode(node) && !isConflictedNode(node) && !isStaleNode(node);
}

function isUncertainNode(node) {
  return (
    isConflictedNode(node) ||
    isStaleNode(node) ||
    UNCERTAIN_STATUSES.has(String(node.status || "").toLowerCase()) ||
    UNCERTAIN_BUCKETS.has(String(node.bucket || "").toLowerCase()) ||
    UNCERTAIN_CONFIDENCE.has(String(node.confidence || "").toLowerCase())
  );
}

function nodeNeedsProposedTicket(node) {
  return isUncertainNode(node) && !isSupersededNode(node);
}

function proposedTicketFor(node, synthesis, sources, docsByRecord, score) {
  const item = itemFor(node, synthesis, sources, docsByRecord, score);
  return {
    source_record_id: item.id,
    proposed_status: "proposed",
    suggested_type: node.type === "contradiction" || isConflictedNode(node) ? "spike" : "task",
    suggested_priority: isConflictedNode(node) ? "P1" : "P2",
    statement: item.statement,
    reason: isConflictedNode(node)
      ? "contradicted business finding must be investigated or resolved before active behavior-changing work"
      : "uncertain business finding must enter proposed intake before becoming schedulable work",
    source_doc: item.source_doc,
    evidence: item.evidence,
  };
}

function countSectionItems(sections, names) {
  return names.reduce((total, name) => total + (sections[name]?.items?.length || 0), 0);
}

function buildGate(sections, proposedTicketRecommendations) {
  const activeContextCount = countSectionItems(sections, [
    "facts",
    "workflows",
    "fields",
    "contracts",
    "workarounds",
    "decisions",
    "adrs",
  ]);
  const approvalItems = sections.approvals?.items || [];
  const hasApprovalOrWaiver = approvalItems.some((item) => {
    const status = String(item.status || "").toLowerCase();
    return status === "accepted" || status === "approved" || status === "waived" || status === "waiver";
  });
  const hasInvestigationStatus =
    (sections.open_questions?.items?.length || 0) > 0 ||
    (sections.conflicts?.items?.length || 0) > 0 ||
    (sections.stale_sources?.items?.length || 0) > 0;
  const unresolvedCount =
    (sections.open_questions?.items?.length || 0) +
    (sections.conflicts?.items?.length || 0) +
    (sections.stale_sources?.items?.length || 0);
  return {
    behavior_change_gate: {
      has_business_context_refs: activeContextCount > 0 || hasInvestigationStatus,
      active_context_count: activeContextCount,
      has_approval_or_waiver: hasApprovalOrWaiver,
      has_investigation_status: hasInvestigationStatus,
      unresolved_uncertain_count: unresolvedCount,
      proposed_ticket_recommendation_count: proposedTicketRecommendations.length,
      status: hasApprovalOrWaiver
        ? "approved_or_waived"
        : unresolvedCount > 0
        ? "investigation_required"
        : activeContextCount > 0
        ? "context_available"
        : "missing_context",
    },
  };
}

function buildTicketContext(ticket, synthesis, sections, proposedTicketRecommendations, coldStartBaseline) {
  const sectionRefs = Object.fromEntries(Object.entries(sections).map(([name, section]) => [name, section.items.map((item) => item.id || item.record_id)]));
  const readout = synthesis.cockpit_readout || {};
  return {
    ticket,
    purpose: "ticket-scoped business discovery readout",
    read_only_contract: READ_ONLY_CONTRACT,
    discovery_run: readout.discovery_runs?.[0] || synthesis.source_run || null,
    cold_start_baseline: coldStartBaseline,
    coverage_gaps: coldStartBaseline.coverage_gaps || coldStartBaseline.inventory_coverage?.gaps || [],
    adapter_signals: readout.adapter_signals || [],
    fact_confidence: {
      by_confidence: readout.fact_confidence?.by_confidence || {},
      by_status: readout.fact_confidence?.by_status || {},
    },
    contradictions: sections.conflicts.items,
    open_questions: sections.open_questions.items,
    decisions: sections.decisions.items.concat(sections.approvals.items),
    adrs: sections.adrs.items,
    adr_history: sections.adr_history.items,
    workarounds: sections.workarounds.items,
    preservation_candidates: (synthesis.preservation_harness_candidates || [])
      .filter((candidate) => sectionRefs.fields.includes(candidate.source_record_id) || sectionRefs.contracts.includes(candidate.source_record_id) || sectionRefs.workarounds.includes(candidate.source_record_id) || sectionRefs.conflicts.includes(candidate.source_record_id))
      .slice(0, proposedTicketRecommendations.length || 6),
    proposed_ticket_recommendations: proposedTicketRecommendations,
    section_record_refs: sectionRefs,
  };
}

function itemFor(node, synthesis, sources, docsByRecord, score) {
  const base = {
    id: node.id,
    kind: node.type,
    statement: node.label || node.id,
    confidence: node.confidence || null,
    status: node.status || null,
    bucket: node.bucket || null,
    superseded_by: node.superseded_by || null,
    conflicts_with: node.conflicts_with || [],
    score,
    source_doc: docsByRecord.get(node.id) || null,
    evidence: evidenceFor(node.id, synthesis, sources),
    why_included: score > 0 ? "matched ticket scope, touched files, or requirement text" : "section fallback for coverage",
  };
  return decorateItem(base, node, score);
}

function packSection(name, kinds, nodes, synthesis, sources, docsByRecord, queryTokens, touchedFiles, limit) {
  const items = nodes
    .filter((node) => kinds.includes(node.type))
    .filter(isActivePackNode)
    .map((node) => ({ node, score: scoreNode(node, queryTokens, touchedFiles) }))
    .filter(({ score }) => score > 0)
    .sort(compareRankedNodes)
    .slice(0, limit)
    .map(({ node, score }) => itemFor(node, synthesis, sources, docsByRecord, score));
  return { name, items };
}

function specialSection(name, nodes, predicate, synthesis, sources, docsByRecord, queryTokens, touchedFiles, limit, why) {
  const scored = nodes
    .filter(predicate)
    .map((node) => ({ node, score: scoreNode(node, queryTokens, touchedFiles) }))
    .filter(({ score }) => score > 0)
    .sort(compareRankedNodes)
    .slice(0, limit)
    .map(({ node, score }) => ({
      ...itemFor(node, synthesis, sources, docsByRecord, score),
      why_included: why,
    }));
  return { name, items: scored };
}

function compareRankedNodes(a, b) {
  const aAuthority = bestSourceAuthority(a.node.__evidence || []).authority;
  const bAuthority = bestSourceAuthority(b.node.__evidence || []).authority;
  const aCategory = rankCategoryFor(a.node, a.score, aAuthority);
  const bCategory = rankCategoryFor(b.node, b.score, bAuthority);
  const byCategory = RANK_CATEGORY_PRIORITY[bCategory] - RANK_CATEGORY_PRIORITY[aCategory];
  if (byCategory !== 0) return byCategory;
  if (b.score !== a.score) return b.score - a.score;
  return a.node.id.localeCompare(b.node.id);
}

function withEvidence(nodes, synthesis, sources) {
  return nodes.map((node) => {
    Object.defineProperty(node, "__evidence", {
      value: evidenceFor(node.id, synthesis, sources),
      enumerable: false,
      configurable: true,
    });
    return node;
  });
}

function itemMetadataForSynthetic(status, confidence, authority, canGovern) {
  return {
    status,
    computed_confidence: confidence,
    conflict_state: status === "conflicted" ? "active_conflict" : "none",
    staleness: status === "stale" ? "stale" : "fresh",
    source_authority: authority,
    can_govern_implementation: canGovern,
    rank_category: canGovern ? "confirmed_rule" : "inferred_context",
    rank_priority: canGovern ? RANK_CATEGORY_PRIORITY.confirmed_rule : RANK_CATEGORY_PRIORITY.inferred_context,
    match_score: 0,
  };
}

function readAdrRegistry(rootDir, adrDir = DEFAULT_ADR_DIR) {
  const root = path.resolve(rootDir || process.cwd(), adrDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => /^[0-9]{4}-.+\.md$/.test(name))
    .sort()
    .map((name) => adrRegistry.parseAdr(path.join(root, name), root));
}

function adrRelevanceText(adr) {
  return [
    adr.id,
    adr.title,
    adr.status,
    (adr.tickets || []).join(" "),
    (adr.requirement_ids || []).join(" "),
    adr.linked_scope,
    adr.decision,
    adr.alternatives_rejected,
    adr.consequences,
    adr.revisit_trigger,
  ].filter(Boolean).join("\n");
}

function adrCitationFor(adr, rootDir, adrDir = DEFAULT_ADR_DIR) {
  const rel = path.join(adrDir, adr.file).split(path.sep).join("/");
  return {
    source_id: `ADR-${adr.id}`,
    label: rel,
    authority: adr.status === "Accepted" ? "accepted_decision" : "unknown",
    visibility: "internal",
    path: rel,
    event_hash: adr.content_hash,
    verified: true,
  };
}

function adrItemFor(adr, score, rootDir, adrDir, why) {
  const active = adr.status === "Accepted" && !adr.superseded_by;
  const citation = adrCitationFor(adr, rootDir, adrDir);
  return {
    id: `ADR-${adr.id}`,
    adr_id: adr.id,
    kind: "adr",
    title: adr.title,
    status: adr.status,
    statement: adr.decision || adr.title || `ADR ${adr.id}`,
    decision: adr.decision,
    rejected_alternatives: adr.alternatives_rejected,
    consequences: adr.consequences,
    revisit_trigger: adr.revisit_trigger,
    requirement_ids: adr.requirement_ids || [],
    tickets: adr.tickets || [],
    supersedes: adr.supersedes || [],
    superseded_by: adr.superseded_by || null,
    source_doc: citation.path,
    evidence: [citation],
    why_included: why,
    ...itemMetadataForSynthetic(
      adr.status || "unknown",
      active ? "high" : "medium",
      active ? "accepted_decision" : "unknown",
      active
    ),
    rank_category: active ? "authoritative_decision" : "inferred_context",
    rank_priority: active ? RANK_CATEGORY_PRIORITY.authoritative_decision : RANK_CATEGORY_PRIORITY.inferred_context,
    match_score: score,
  };
}

function adrSections(adrs, queryTokens, touchedFiles, rootDir, adrDir, limit) {
  const scored = adrs
    .map((adr) => ({ adr, score: scoreText(adrRelevanceText(adr), queryTokens, touchedFiles) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || String(a.adr.id).localeCompare(String(b.adr.id)));
  return {
    adrs: {
      name: "adrs",
      items: scored
        .filter(({ adr }) => adr.status === "Accepted" && !adr.superseded_by)
        .slice(0, limit)
        .map(({ adr, score }) => adrItemFor(adr, score, rootDir, adrDir, "accepted ADR matched ticket scope, touched files, or requirement text")),
    },
    adr_history: {
      name: "adr_history",
      items: scored
        .filter(({ adr }) => adr.status !== "Accepted" || adr.superseded_by)
        .slice(0, limit)
        .map(({ adr, score }) => adrItemFor(
          adr,
          score,
          rootDir,
          adrDir,
          adr.status === "Superseded" || adr.superseded_by
            ? "history-only ADR; superseded decisions are excluded from active guidance"
            : "non-accepted ADR history; useful context but not active guidance"
        )),
    },
  };
}

function buildRanking(sections) {
  const items = Object.entries(sections)
    .flatMap(([section, value]) => value.items.map((item) => ({ section, item })))
    .filter(({ item }) => item && item.id)
    .sort((a, b) => {
      if (b.item.rank_priority !== a.item.rank_priority) return b.item.rank_priority - a.item.rank_priority;
      if (b.item.match_score !== a.item.match_score) return b.item.match_score - a.item.match_score;
      return String(a.item.id).localeCompare(String(b.item.id));
    })
    .map(({ section, item }, index) => ({
      rank: index + 1,
      section,
      id: item.id,
      rank_category: item.rank_category,
      why_included: item.why_included,
      status: item.status,
      computed_confidence: item.computed_confidence,
      conflict_state: item.conflict_state,
      staleness: item.staleness,
      source_authority: item.source_authority,
      can_govern_implementation: item.can_govern_implementation,
      match_score: item.match_score,
    }));
  return {
    order: Object.keys(RANK_CATEGORY_PRIORITY),
    items,
  };
}

function buildPack(synthesis, options = {}) {
  if (!synthesis || synthesis.kind !== "concord.business_discovery.synthesis") {
    throw new Error("Input must be a concord.business_discovery.synthesis artifact.");
  }
  const ticket = String(options.ticket || "").trim();
  if (!ticket) throw new Error("ticket is required.");
  const scope = String(options.scope || "");
  const touchedFiles = options.touchedFiles || [];
  const requirements = options.requirements || [];
  const queryTokens = tokenize([ticket, scope, ...touchedFiles, ...requirements].join(" "));
  // COORD-366/COORD-370: the ticket's change surface (scope + requirement text +
  // touched files, NOT the generic ticket id). When present, gate-bearing
  // sections (open_questions, recommendations) scope to it; when ABSENT (an
  // undeclared ticket) they fall back to the prior repo-wide behavior so the gate
  // cannot be silently dodged.
  const contentTokens = tokenize([scope, ...requirements].join(" "));
  const hasChangeSurface = touchedFiles.length > 0 || contentTokens.length > 0;
  const sources = sourceById(synthesis);
  const nodes = withEvidence(recordNodes(synthesis), synthesis, sources);
  const coldStartBaseline = coldStartBaselineFor(synthesis, nodes);
  const docsByRecord = docRecordMap(synthesis);
  const limit = options.limit || 6;
  const rootDir = options.rootDir || options.cwd || process.cwd();
  const adrDir = options.adrDir || DEFAULT_ADR_DIR;

  const sections = {};
  for (const [name, kinds] of Object.entries(SECTION_KINDS)) {
    sections[name] = packSection(name, kinds, nodes, synthesis, sources, docsByRecord, queryTokens, touchedFiles, limit);
  }

  sections.conflicts = specialSection(
    "conflicts",
    nodes,
    isConflictedNode,
    synthesis,
    sources,
    docsByRecord,
    queryTokens,
    touchedFiles,
    limit,
    "active unresolved conflict; do not treat as active constraint until resolved, superseded, approved, or waived"
  );
  sections.history = specialSection(
    "history",
    nodes,
    isSupersededNode,
    synthesis,
    sources,
    docsByRecord,
    queryTokens,
    touchedFiles,
    limit,
    "history-only recall; superseded knowledge is excluded from active constraints"
  );
  sections.stale_sources = specialSection(
    "stale_sources",
    nodes,
    isStaleNode,
    synthesis,
    sources,
    docsByRecord,
    queryTokens,
    touchedFiles,
    limit,
    "source-hash drift or stale status; revalidate before active use"
  );

  // COORD-370 (HIGH-2): scope open questions to the change surface when one exists,
  // so a precisely-scoped maintenance pack does not inherit repo-wide open questions
  // (which context_pack_ack treats as mandatory ceremony). Undeclared tickets keep
  // the full set (same fallback as recommendations) so they cannot dodge the gate.
  const scopedUnknowns = (synthesis.unknowns || []).filter((unknown) =>
    hasChangeSurface
      ? changeSurfaceRelevance(
          { id: unknown.id, label: unknown.statement, type: unknown.kind },
          contentTokens,
          touchedFiles
        ) > 0
      : true
  );
  sections.open_questions = {
    name: "open_questions",
    items: scopedUnknowns
      .map((unknown) => ({
        id: unknown.id,
        kind: unknown.kind,
        statement: unknown.statement,
        reason: unknown.reason,
        why_included: "unknowns and open questions are mandatory context",
        ...itemMetadataForSynthetic("open_question", "low", "unknown", false),
      }))
      .slice(0, limit),
  };
  sections.approvals = {
    name: "approvals",
    items: (synthesis.promotion_candidates || [])
      .filter((candidate) => candidate.status === "accepted" || candidate.required_reviewer)
      .slice(0, limit)
      .map((candidate) => ({
        id: candidate.id,
        record_id: candidate.record_id,
        target: candidate.target,
        status: candidate.status,
        required_reviewer: candidate.required_reviewer || null,
        reason: candidate.reason || null,
        why_included: "promotion candidate or approval requirement",
        ...itemMetadataForSynthetic(candidate.status || "review_required", candidate.status === "accepted" ? "high" : "medium", candidate.status === "accepted" ? "accepted_decision" : "human_review_comment", candidate.status === "accepted"),
      })),
  };
  const adrPackSections = adrSections(
    readAdrRegistry(rootDir, adrDir),
    queryTokens,
    touchedFiles,
    rootDir,
    adrDir,
    limit
  );
  sections.adrs = adrPackSections.adrs;
  sections.adr_history = adrPackSections.adr_history;
  // COORD-366: scope the gate-blocking recommendations to the ticket's change
  // surface. Content tokens come from scope + requirement text ONLY (NOT the bare
  // ticket id, whose generic "coord" token matched nearly every node, and NOT the
  // touched-file PATHS, which re-introduce the same generic tokens — touched files
  // are matched precisely below instead). When the ticket declares SOME scope
  // (touched files, scope text, or requirements) a recommendation must be relevant
  // to it; when it declares NONE we fall back to the prior bucket-based behavior so
  // an undeclared ticket cannot silently dodge the gate.
  const proposedTicketRecommendations = nodes
    .filter(nodeNeedsProposedTicket)
    .map((node) => ({
      node,
      score: scoreNode(node, queryTokens, touchedFiles),
      relevance: changeSurfaceRelevance(node, contentTokens, touchedFiles),
    }))
    .filter(({ relevance, score }) => (hasChangeSurface ? relevance > 0 : score > 0))
    .sort(compareRankedNodes)
    .slice(0, limit)
    .map(({ node, score }) => proposedTicketFor(node, synthesis, sources, docsByRecord, score));
  const gate = buildGate(sections, proposedTicketRecommendations);
  const ticketContext = buildTicketContext(ticket, synthesis, sections, proposedTicketRecommendations, coldStartBaseline);
  const ranking = buildRanking(sections);

  return {
    kind: ARTIFACT_KIND,
    schema_version: 1,
    read_only_contract: READ_ONLY_CONTRACT,
    usage_ack_contract: USAGE_ACK_CONTRACT,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    ticket,
    input: {
      source_kind: synthesis.kind,
      source_generated_at_utc: synthesis.generated_at_utc || null,
    },
    cold_start_baseline: coldStartBaseline,
    sparse_memory_warning: coldStartBaseline.sparse_memory ? coldStartBaseline.authority_warning : null,
    query: {
      scope,
      touched_files: touchedFiles,
      requirements,
      tokens: queryTokens,
    },
    refs: {
      json: `coord/.runtime/context-packs/${ticket}.json`,
      markdown: `coord/.runtime/context-packs/${ticket}.md`,
    },
    gate,
    ranking,
    ticket_context: ticketContext,
    proposed_ticket_recommendations: proposedTicketRecommendations,
    sections,
    summary: Object.fromEntries(Object.entries(sections).map(([name, section]) => [name, section.items.length])),
  };
}

function renderMarkdown(pack) {
  const lines = [`# Business Context Pack: ${pack.ticket}`, "", `Scope: ${pack.query.scope || "(none)"}`, ""];
  if (pack.cold_start_baseline?.sparse_memory) {
    lines.push("## sparse memory warning");
    lines.push(`- ${pack.cold_start_baseline.authority_warning}`);
    const gaps = pack.cold_start_baseline.coverage_gaps || pack.cold_start_baseline.inventory_coverage?.gaps || [];
    if (gaps.length > 0) lines.push(`- Coverage gaps: ${gaps.join(", ")}`);
    lines.push("");
  }
  if (pack.gate?.behavior_change_gate) {
    const gate = pack.gate.behavior_change_gate;
    lines.push("## behavior change gate");
    lines.push(`- Status: ${gate.status}`);
    lines.push(`- Business context refs: ${gate.has_business_context_refs ? "yes" : "no"}`);
    lines.push(`- Approval or waiver: ${gate.has_approval_or_waiver ? "yes" : "no"}`);
    lines.push(`- Investigation status: ${gate.has_investigation_status ? "yes" : "no"}`);
    lines.push(`- Proposed ticket recommendations: ${gate.proposed_ticket_recommendation_count}`);
    lines.push("");
  }
  if (pack.proposed_ticket_recommendations?.length > 0) {
    lines.push("## proposed ticket recommendations");
    for (const item of pack.proposed_ticket_recommendations) {
      lines.push(`- ${item.source_record_id}: ${item.statement}`);
      lines.push(`  Status: ${item.proposed_status}; Type: ${item.suggested_type}; Priority: ${item.suggested_priority}`);
      lines.push(`  Why: ${item.reason}`);
    }
    lines.push("");
  }
  for (const [name, section] of Object.entries(pack.sections)) {
    lines.push(`## ${name.replace(/_/g, " ")}`);
    if (section.items.length === 0) {
      lines.push("No relevant items selected.");
      lines.push("");
      continue;
    }
    for (const item of section.items) {
      lines.push(`- ${item.id || item.record_id}: ${item.statement || item.reason || item.target}`);
      if (item.evidence && item.evidence.length > 0) {
        lines.push(`  Evidence: ${item.evidence.map((e) => `${e.source_id}:${e.label}`).join("; ")}`);
      }
      if (item.why_included) lines.push(`  Why: ${item.why_included}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function buildWarmStartContextFromPack(pack) {
  if (!pack || pack.kind !== ARTIFACT_KIND) {
    throw new Error("Input must be a concord.business_context_pack artifact.");
  }
  const uncertain = []
    .concat(pack.sections?.conflicts?.items || [])
    .concat(pack.sections?.stale_sources?.items || [])
    .concat(pack.sections?.open_questions?.items || []);
  return {
    kind: "concord.continuity_warm_start_context_pack_ref",
    schema_version: "continuity-bridge-mvp/v1",
    ticket: pack.ticket,
    source_kind: pack.kind,
    source_refs: pack.refs || {},
    sparse_memory_warning: pack.sparse_memory_warning || null,
    coverage_gaps: pack.cold_start_baseline?.coverage_gaps || pack.ticket_context?.coverage_gaps || [],
    gate: pack.gate?.behavior_change_gate || null,
    active_context: {
      facts: pack.sections?.facts?.items || [],
      workflows: pack.sections?.workflows?.items || [],
      fields: pack.sections?.fields?.items || [],
      contracts: pack.sections?.contracts?.items || [],
      decisions: pack.sections?.decisions?.items || [],
      adrs: pack.sections?.adrs?.items || [],
    },
    uncertain_context: uncertain,
    open_decisions: []
      .concat(pack.ticket_context?.decisions || [])
      .concat(pack.ticket_context?.open_questions || []),
    verification_needed: uncertain.map((item) => ({
      id: item.id || item.record_id,
      reason: item.why_included || item.reason || "uncertain context requires verification before active use",
    })),
  };
}

function writeFile(root, filePath, body) {
  const outputPath = path.resolve(root, filePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, body);
}

// COORD-366: read a ticket's declared change surface (intended_files) from its
// canonical plan record, so a default pack can scope to it. Best-effort: returns
// [] when the record is absent/unreadable (an undeclared ticket falls back to the
// prior gate behavior rather than silently scoping to nothing).
function readTicketIntendedFiles(cwd, ticket) {
  if (!ticket) return [];
  try {
    const planPath = path.resolve(cwd, "coord", ".runtime", "plans", `${ticket}.json`);
    const record = JSON.parse(fs.readFileSync(planPath, "utf8"));
    const files = Array.isArray(record.intended_files) ? record.intended_files : [];
    return files
      .filter((f) => typeof f === "string" && f.trim())
      .map((f) => f.trim())
      // COORD-370 (regression from COORD-366): a freshly-seeded plan often holds
      // ONLY a scaffold worktree placeholder (<repo>/.worktrees/<owner>/<ticket>/*).
      // Treating that as a "change surface" made hasChangeSurface true while
      // matching no business records, dropping recommendations to 0 — a SILENT
      // GATE BYPASS. Exclude the structural placeholder so a placeholder-only plan
      // yields [] and falls back to the undeclared-ticket behavior (surface
      // findings), not a bypass.
      .filter((f) => !isScaffoldWorktreePlaceholder(f));
  } catch (error) {
    return [];
  }
}

// Structural detection of the scaffold worktree placeholder a fresh plan seeds:
// `<repo-prefix>/.worktrees/<owner>/<ticket>/...` (cf plan-records
// isScaffoldWorktreeIntendedFile). Not a real change surface.
function isScaffoldWorktreePlaceholder(file) {
  return /(^|\/)\.worktrees\/[^/]+\/[^/]+(\/|$)/.test(String(file || ""));
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  if (parsed.error) {
    log(`business-context-pack: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: business-context-pack --ticket <id> [--input <synthesis.json>] [--scope <text>] [--touched-file <path>] [--requirement <text>] [--json] [--output <path>] [--output-md <path>] [--write-default]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const inputPath = path.resolve(cwd, parsed.options.input);
  let synthesis;
  try {
    synthesis = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch (error) {
    // COORD-368: the gate suggests this command, but in a COLD repo (discovery not
    // yet run) the synthesis is absent and the old generic error dead-ended the
    // operator. Detect the missing synthesis and emit a GRADUATED next-step:
    // run discovery first, OR — if this ticket has no business-context dimension —
    // record an explicit investigation disposition (which now neutralizes the gate,
    // COORD-367). Other read errors (corrupt JSON) keep the original message.
    if (error && error.code === "ENOENT") {
      const ticketArg = parsed.options.ticket ? ` --ticket ${parsed.options.ticket}` : "";
      log(
        `business-context-pack: no business-discovery synthesis at ${parsed.options.input}.\n` +
          `Next steps (pick one):\n` +
          `  1. Generate discovery first, then retry:\n` +
          `       coord/scripts/coord business-discovery${ticketArg}\n` +
          `  2. If this ticket has NO business-context dimension, record the disposition\n` +
          `     (this neutralizes the gate — see COORD-367):\n` +
          `       coord/scripts/gov update-plan ${parsed.options.ticket || "<ticket>"} --invariant "business-context investigation: not-required"`
      );
      return { code: 1, reason: "missing_synthesis" };
    }
    log(`business-context-pack: unable to read ${parsed.options.input}: ${error.message}`);
    return { code: 1 };
  }
  // COORD-366: a default pack (the gate's suggested `--write-default`) must scope
  // its gate-blocking recommendations to the ticket's actual change surface, not
  // the repo-wide corpus. When no --touched-file was passed, default to the
  // ticket's declared intended_files from its plan record, so a 2-file checksum
  // re-baseline does not surface every uncertain finding in the repo.
  let touchedFiles = parsed.options.touchedFiles;
  if ((!touchedFiles || touchedFiles.length === 0)) {
    const intended = readTicketIntendedFiles(cwd, parsed.options.ticket);
    if (intended.length > 0) touchedFiles = intended;
  }
  let pack;
  try {
    pack = buildPack(synthesis, { ...parsed.options, touchedFiles, rootDir: cwd });
  } catch (error) {
    log(`business-context-pack: ${error.message}`);
    return { code: 1 };
  }
  const jsonBody = `${JSON.stringify(pack, null, 2)}\n`;
  const mdBody = renderMarkdown(pack);
  const jsonOutput = parsed.options.writeDefault ? pack.refs.json : parsed.options.output;
  const mdOutput = parsed.options.writeDefault ? pack.refs.markdown : parsed.options.outputMd;
  if (jsonOutput) writeFile(cwd, jsonOutput, jsonBody);
  if (mdOutput) writeFile(cwd, mdOutput, mdBody);
  if (!jsonOutput && !mdOutput) log(parsed.options.json ? jsonBody.trimEnd() : mdBody.trimEnd());
  return { code: 0, pack };
}

module.exports = {
  ARTIFACT_KIND,
  DEFAULT_ADR_DIR,
  buildPack,
  buildWarmStartContextFromPack,
  isScaffoldWorktreePlaceholder,
  readTicketIntendedFiles,
  parseArgs,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
