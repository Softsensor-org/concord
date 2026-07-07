#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ARTIFACT_KIND = "concord.business_discovery.synthesis";
const DEFAULT_INPUT = "coord/.runtime/discovery/run.json";
const DEFAULT_OUTPUT = "coord/.runtime/discovery/synthesis.json";

const DOCS = [
  ["BUSINESS_CONTEXT.md", "Business Context", ["business_object", "configuration_surface", "fact"]],
  ["WORKFLOW_INVENTORY.md", "Workflow Inventory", ["workflow", "ux_behavior"]],
  ["DOWNSTREAM_CONTRACTS.md", "Downstream Contracts", ["integration_contract", "data_dependency", "field_rule"]],
  ["BUSINESS_RULES.md", "Business Rules", ["business_rule", "field_rule"]],
  ["KNOWN_WORKAROUNDS.md", "Known Workarounds", ["hypothesis", "contradiction", "reflection"]],
  ["DECISION_LOG.md", "Decision Log", ["decision"]],
];

const READ_ONLY_CONTRACT = Object.freeze({
  ui_tier: "read_only",
  discovery_execution_allowed: false,
  file_mutation_allowed: false,
  mutation_path: "Run discovery, synthesis, context-pack generation, and promotions through explicit governed CLI commands; cockpit/readout surfaces only render existing derived artifacts.",
});

function parseArgs(argv = []) {
  const options = {
    input: DEFAULT_INPUT,
    json: false,
    output: null,
    outputDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--write-default") {
      options.output = DEFAULT_OUTPUT;
      options.json = true;
      continue;
    }
    if (["--input", "--output", "--output-dir"].includes(arg)) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[++i];
      if (!value) return { error: `${arg} requires a value` };
      options[key] = value;
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  return { options };
}

function byId(items = []) {
  return new Map(items.map((item) => [item.id, item]));
}

function evidenceLabels(record, sourcesById) {
  return (record.evidence || []).map((ref) => {
    const source = sourcesById.get(ref.source_id);
    if (!source) return ref.source_id;
    const location = source.path || source.uri || source.id;
    return `${source.id} ${source.authority || "unknown"} ${location}`;
  });
}

function confidenceBucket(record) {
  if (record.confidence === "confirmed" && record.status === "accepted") return "accepted";
  if (record.confidence === "contradicted" || record.kind === "contradiction") return "contradicted";
  if (["unknown", "hypothesis", "inferred"].includes(record.confidence)) return "unknown";
  if (record.confidence === "observed") return "observed";
  return "candidate";
}

function makeDoc(file, title, records, sourcesById) {
  const lines = [`# ${title}`, "", "Status: derived discovery synthesis. Do not treat this as accepted policy until promoted.", ""];
  if (records.length === 0) {
    lines.push("No candidate records found in the discovery run.");
  }
  for (const record of records) {
    lines.push(`## ${record.id}`);
    lines.push("");
    lines.push(record.statement);
    lines.push("");
    lines.push(`- Kind: ${record.kind}`);
    lines.push(`- Confidence: ${record.confidence}`);
    lines.push(`- Status: ${record.status}`);
    if (record.subject) lines.push(`- Subject: ${record.subject}`);
    if (record.predicate) lines.push(`- Predicate: ${record.predicate}`);
    if (record.object) lines.push(`- Object: ${record.object}`);
    const labels = evidenceLabels(record, sourcesById);
    lines.push("- Evidence:");
    for (const label of labels) lines.push(`  - ${label}`);
    lines.push("");
  }
  return { file, title, content: `${lines.join("\n").trimEnd()}\n`, record_ids: records.map((record) => record.id) };
}

function harnessCandidateFor(record, sourcesById) {
  const evidence = evidenceLabels(record, sourcesById);
  const base = {
    source_record_id: record.id,
    subject: record.subject || null,
    statement: record.statement,
    evidence,
    status: "candidate",
    approval_required: true,
  };
  if (record.kind === "business_rule" || record.kind === "field_rule") {
    return {
      ...base,
      harness_type: "validator",
      suggested_artifact: `${record.id}.validator.spec`,
      rationale: "Business and field rules need explicit validation before refactors can rely on them.",
    };
  }
  if (record.kind === "workflow" || record.kind === "ux_behavior") {
    return {
      ...base,
      harness_type: "workflow_simulation",
      suggested_artifact: `${record.id}.workflow.spec`,
      rationale: "Workflow and UX behavior should be preserved with a scenario simulation.",
    };
  }
  if (record.kind === "integration_contract") {
    return {
      ...base,
      harness_type: "adapter_contract_check",
      suggested_artifact: `${record.id}.contract.spec`,
      rationale: "Integration contracts need adapter-level conformance checks before downstream changes.",
    };
  }
  if (record.kind === "data_dependency") {
    return {
      ...base,
      harness_type: "schema_lineage_check",
      suggested_artifact: `${record.id}.lineage.spec`,
      rationale: "Data dependencies need schema, lineage, or row-shape checks to preserve reports and exports.",
    };
  }
  if (record.kind === "configuration_surface") {
    return {
      ...base,
      harness_type: "configuration_fixture",
      suggested_artifact: `${record.id}.fixture`,
      rationale: "Configuration-driven behavior should have a golden fixture before generalized changes.",
    };
  }
  if (record.kind === "contradiction" || record.confidence === "contradicted") {
    return {
      ...base,
      harness_type: "regression_reproduction",
      suggested_artifact: `${record.id}.regression.spec`,
      rationale: "Contradictions need a reproduction candidate before the system chooses a rule to preserve.",
    };
  }
  if (record.kind === "hypothesis" || ["unknown", "hypothesis", "inferred"].includes(record.confidence)) {
    return {
      ...base,
      harness_type: "golden_fixture_candidate",
      suggested_artifact: `${record.id}.golden-fixture`,
      rationale: "Uncertain discoveries can suggest fixture candidates but cannot become implementation tests without approval.",
    };
  }
  return null;
}

function buildPreservationHarnessCandidates(records, sourcesById) {
  return records
    .map((record) => harnessCandidateFor(record, sourcesById))
    .filter(Boolean)
    .sort((a, b) => {
      const byType = a.harness_type.localeCompare(b.harness_type);
      if (byType !== 0) return byType;
      return a.source_record_id.localeCompare(b.source_record_id);
    });
}

function countBy(records, field) {
  const counts = {};
  for (const record of records) {
    const key = record[field] || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function summarizeRun(run, records) {
  return {
    kind: run.kind,
    generated_at_utc: run.generated_at_utc || null,
    generator: run.generator || null,
    project: run.project || null,
    summary: {
      records: records.length,
      sources: (run.sources || []).length,
      questions: (run.question_ledger || run.questions || []).length,
      decisions: (run.decision_ledger || []).length,
      reflections: (run.reflection_ledger || []).length,
      adapter_signals: (run.adapter_signals || []).length,
    },
  };
}

function recordSummary(record, sourcesById) {
  return {
    id: record.id,
    kind: record.kind,
    statement: record.statement,
    subject: record.subject || null,
    confidence: record.confidence || "unknown",
    status: record.status || "candidate",
    can_guide_implementation: Boolean(record.authority?.can_guide_implementation),
    approval_required: record.authority?.approval_required !== false,
    evidence: evidenceLabels(record, sourcesById),
  };
}

function buildCockpitReadout(run, records, sourcesById, contradictions, unknowns, preservationHarnessCandidates, docs) {
  const workaroundKinds = new Set(["hypothesis", "reflection", "contradiction"]);
  const factKinds = new Set(["fact", "business_object", "field_rule", "business_rule", "configuration_surface"]);
  const decisions = [
    ...(run.decision_ledger || []).map((decision) => ({
      id: decision.id,
      status: decision.status || "pending",
      owner: decision.owner || null,
      question: decision.question || decision.statement || null,
      options: decision.options || [],
      consequence: decision.consequence || decision.consequences || null,
      evidence: decision.evidence || [],
    })),
    ...records
      .filter((record) => record.kind === "decision")
      .map((record) => recordSummary(record, sourcesById)),
  ];
  return {
    kind: "concord.business_discovery.cockpit_readout",
    schema_version: 1,
    read_only_contract: READ_ONLY_CONTRACT,
    discovery_runs: [summarizeRun(run, records)],
    adapter_signals: (run.adapter_signals || []).map((signal) => ({
      id: signal.id,
      label: signal.label,
      confidence: signal.confidence,
      matched_paths: signal.matched_paths || [],
      probes: signal.probes || [],
      risks: signal.risks || [],
      questions: signal.questions || [],
    })),
    fact_confidence: {
      by_confidence: countBy(records, "confidence"),
      by_status: countBy(records, "status"),
      facts: records.filter((record) => factKinds.has(record.kind)).map((record) => recordSummary(record, sourcesById)),
    },
    contradictions: contradictions.map((item) => ({
      id: item.id,
      record_ids: item.record_ids || [],
      status: item.status || "open",
      statement: item.statement,
      resolution: item.resolution || null,
    })),
    open_questions: [
      ...unknowns,
      ...(run.question_ledger || []).map((question) => ({
        id: question.id,
        kind: "question",
        statement: question.question || question.statement,
        reason: question.reason || question.impact || "open_question",
        owner: question.owner || null,
        priority: question.priority || null,
        decision_required: Boolean(question.decision_required),
      })),
    ],
    decisions,
    workarounds: records
      .filter((record) => workaroundKinds.has(record.kind))
      .map((record) => recordSummary(record, sourcesById)),
    preservation_candidates: preservationHarnessCandidates,
    ticket_context_packs: {
      command: "coord/scripts/coord business-context-pack --ticket <ticket-id> --input coord/.runtime/discovery/synthesis.json --scope <scope> --json",
      default_json_ref: "coord/.runtime/context-packs/<ticket-id>.json",
      default_markdown_ref: "coord/.runtime/context-packs/<ticket-id>.md",
      source_doc_count: docs.length,
    },
  };
}

function makePreservationHarnessDoc(candidates) {
  const lines = [
    "# Preservation Harness Candidates",
    "",
    "Status: derived discovery synthesis. These are candidate tests, validators, simulations, and fixtures only.",
    "Do not create implementation tests from these candidates until a governed ticket approves the harness.",
    "",
  ];
  if (candidates.length === 0) {
    lines.push("No preservation harness candidates found in the discovery run.");
  }
  for (const candidate of candidates) {
    lines.push(`## ${candidate.source_record_id}`);
    lines.push("");
    lines.push(candidate.statement);
    lines.push("");
    lines.push(`- Harness type: ${candidate.harness_type}`);
    lines.push(`- Suggested artifact: ${candidate.suggested_artifact}`);
    lines.push(`- Approval required: ${candidate.approval_required ? "yes" : "no"}`);
    lines.push(`- Rationale: ${candidate.rationale}`);
    if (candidate.evidence.length > 0) {
      lines.push("- Evidence:");
      for (const label of candidate.evidence) lines.push(`  - ${label}`);
    }
    lines.push("");
  }
  return {
    file: "PRESERVATION_HARNESS_CANDIDATES.md",
    title: "Preservation Harness Candidates",
    content: `${lines.join("\n").trimEnd()}\n`,
    record_ids: candidates.map((candidate) => candidate.source_record_id),
  };
}

function synthesize(run, options = {}) {
  if (!run || run.kind !== "concord.business_discovery.run") {
    throw new Error("Input must be a concord.business_discovery.run artifact.");
  }
  const sourcesById = byId(run.sources || []);
  const records = run.records || [];
  const graphNodes = [];
  const graphEdges = [];
  const sourceUse = new Map();

  for (const source of run.sources || []) {
    graphNodes.push({
      id: source.id,
      type: "evidence",
      label: source.path || source.uri || source.id,
      authority: source.authority,
      visibility: source.visibility,
    });
  }

  for (const record of records) {
    const bucket = confidenceBucket(record);
    graphNodes.push({
      id: record.id,
      type: record.kind,
      label: record.subject || record.statement,
      confidence: record.confidence,
      status: record.status,
      bucket,
    });
    for (const ref of record.evidence || []) {
      graphEdges.push({ from: record.id, type: "proven_by", to: ref.source_id });
      sourceUse.set(ref.source_id, (sourceUse.get(ref.source_id) || 0) + 1);
    }
  }

  for (const question of run.questions || []) {
    graphNodes.push({ id: question.id, type: "question", label: question.question, status: question.status });
    for (const blocked of question.blocks || []) graphEdges.push({ from: question.id, type: "blocks_promotion_of", to: blocked });
  }

  for (const relationship of run.relationships || []) {
    graphEdges.push({
      from: relationship.from,
      type: relationship.type,
      to: relationship.to,
    });
  }

  const docs = DOCS.map(([file, title, kinds]) => makeDoc(
    file,
    title,
    records.filter((record) => kinds.includes(record.kind)),
    sourcesById
  ));
  const preservationHarnessCandidates = buildPreservationHarnessCandidates(records, sourcesById);
  docs.push(makePreservationHarnessDoc(preservationHarnessCandidates));

  const openQuestionDoc = {
    file: "OPEN_BUSINESS_QUESTIONS.md",
    title: "Open Business Questions",
    content: renderQuestions(run),
    record_ids: [],
  };
  docs.push(openQuestionDoc);

  const contradictions = [
    ...(run.contradictions || []),
    ...records
      .filter((record) => record.kind === "contradiction" || record.confidence === "contradicted")
      .map((record) => ({
        id: `SYN-CONTRADICTION-${record.id}`,
        record_ids: [record.id],
        status: "open",
        statement: record.statement,
        resolution: null,
      })),
  ];

  const unknowns = [
    ...records
      .filter((record) => ["unknown", "hypothesis", "inferred"].includes(record.confidence))
      .map((record) => ({ id: record.id, kind: record.kind, statement: record.statement, reason: record.confidence })),
    ...(run.questions || []).map((question) => ({ id: question.id, kind: "question", statement: question.question, reason: "open_question" })),
  ];
  const cockpitReadout = buildCockpitReadout(run, records, sourcesById, contradictions, unknowns, preservationHarnessCandidates, docs);

  return {
    kind: ARTIFACT_KIND,
    schema_version: 1,
    source_run: {
      kind: run.kind,
      generated_at_utc: run.generated_at_utc || null,
      generator: run.generator || null,
      project: run.project || null,
    },
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    generator: {
      name: "business-discovery-synthesize",
      version: "0.1.0",
      command: "coord business-discovery-synthesize --json",
    },
    read_only_contract: READ_ONLY_CONTRACT,
    cockpit_readout: cockpitReadout,
    context_graph: {
      nodes: graphNodes,
      edges: graphEdges,
    },
    evidence_classification: classifyEvidence(run.sources || [], sourceUse),
    contradictions,
    unknowns,
    promoted_docs: docs,
    preservation_harness_candidates: preservationHarnessCandidates,
    promotion_candidates: run.promotion_candidates || [],
    summary: {
      records: records.length,
      sources: (run.sources || []).length,
      graph_nodes: graphNodes.length,
      graph_edges: graphEdges.length,
      docs: docs.length,
      contradictions: contradictions.length,
      unknowns: unknowns.length,
      preservation_harness_candidates: preservationHarnessCandidates.length,
      promotion_candidates: (run.promotion_candidates || []).length,
      cockpit_sections: Object.keys(cockpitReadout).length,
    },
  };
}

function classifyEvidence(sources, sourceUse) {
  const byAuthority = {};
  const byVisibility = {};
  for (const source of sources) {
    byAuthority[source.authority || "unknown"] = (byAuthority[source.authority || "unknown"] || 0) + 1;
    byVisibility[source.visibility || "unknown"] = (byVisibility[source.visibility || "unknown"] || 0) + 1;
  }
  return {
    by_authority: byAuthority,
    by_visibility: byVisibility,
    cited_sources: Array.from(sourceUse.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([source_id, citations]) => ({ source_id, citations })),
  };
}

function renderQuestions(run) {
  const lines = [
    "# Open Business Questions",
    "",
    "Status: derived discovery synthesis. Answers must be captured through governed decisions, requirements, ADRs, or accepted memory.",
    "",
  ];
  const questions = run.questions || [];
  if (questions.length === 0) lines.push("No open questions found in the discovery run.");
  for (const question of questions) {
    lines.push(`## ${question.id}`);
    lines.push("");
    lines.push(question.question);
    lines.push("");
    lines.push(`- Owner: ${question.owner || "unassigned"}`);
    lines.push(`- Status: ${question.status}`);
    if ((question.blocks || []).length > 0) {
      lines.push("- Blocks:");
      for (const blocked of question.blocks) lines.push(`  - ${blocked}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderMarkdown(synthesis) {
  const lines = [];
  lines.push("# Business Discovery Synthesis");
  lines.push("");
  lines.push(`Records: ${synthesis.summary.records}`);
  lines.push(`Context graph: ${synthesis.summary.graph_nodes} nodes, ${synthesis.summary.graph_edges} edges`);
  lines.push(`Unknowns: ${synthesis.summary.unknowns}`);
  lines.push(`Contradictions: ${synthesis.summary.contradictions}`);
  lines.push(`Preservation harness candidates: ${synthesis.summary.preservation_harness_candidates}`);
  lines.push(`Read-only UI contract: ${synthesis.read_only_contract.ui_tier}`);
  lines.push("");
  lines.push("## Promoted Doc Drafts");
  for (const doc of synthesis.promoted_docs) lines.push(`- ${doc.file}: ${doc.record_ids.length} record(s)`);
  return lines.join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeOutput(root, output, body) {
  const outputPath = path.resolve(root, output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${body}\n`);
}

function writeDocs(root, outputDir, synthesis) {
  const dir = path.resolve(root, outputDir);
  fs.mkdirSync(dir, { recursive: true });
  for (const doc of synthesis.promoted_docs) {
    fs.writeFileSync(path.join(dir, doc.file), doc.content);
  }
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  if (parsed.error) {
    log(`business-discovery-synthesize: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: business-discovery-synthesize [--input <run.json>] [--json] [--output <path>] [--output-dir <dir>] [--write-default]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const inputPath = path.resolve(cwd, parsed.options.input);
  let sourceRun;
  try {
    sourceRun = readJson(inputPath);
  } catch (error) {
    log(`business-discovery-synthesize: unable to read ${parsed.options.input}: ${error.message}`);
    return { code: 1 };
  }
  let synthesis;
  try {
    synthesis = synthesize(sourceRun);
  } catch (error) {
    log(`business-discovery-synthesize: ${error.message}`);
    return { code: 1 };
  }
  const body = parsed.options.json || parsed.options.output ? JSON.stringify(synthesis, null, 2) : renderMarkdown(synthesis);
  if (parsed.options.output) writeOutput(cwd, parsed.options.output, body);
  if (parsed.options.outputDir) writeDocs(cwd, parsed.options.outputDir, synthesis);
  if (!parsed.options.output && !parsed.options.outputDir) log(body);
  return { code: 0, synthesis };
}

module.exports = {
  ARTIFACT_KIND,
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  parseArgs,
  renderMarkdown,
  synthesize,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
