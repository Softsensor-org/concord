#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CLASSIFICATIONS = new Set([
  "aligned",
  "partial",
  "deferred_by_urs",
  "outside_current_scope",
  "future_addendum_candidate",
]);

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "").split(/[,;|]/).map((item) => item.trim()).filter(Boolean);
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s/-]+/g, "_");
}

function registryIds(registry = {}) {
  return new Set((registry.requirements || []).map((req) => String(req.id || "").toUpperCase()).filter(Boolean));
}

function normalizeRequirementRefs(workflow) {
  return asList(workflow.requirement_ids || workflow.requirement_id)
    .concat((workflow.requirement_refs || []).map((ref) => ref.id || ref.requirement_id || ref.anchor || "").filter(Boolean))
    .map((id) => String(id).toUpperCase())
    .sort();
}

function implementationRefs(workflow) {
  return {
    routes: asList(workflow.routes || workflow.route).sort(),
    pages: asList(workflow.pages || workflow.page).sort(),
    services: asList(workflow.services || workflow.service).sort(),
    apis: asList(workflow.apis || workflow.api).sort(),
    design_docs: asList(workflow.design_docs || workflow.design_doc).sort(),
    board_ticket_ids: asList(workflow.board_ticket_ids || workflow.tickets || workflow.ticket_ids).sort(),
  };
}

function hasImplementation(refs) {
  return Object.values(refs).some((items) => items.length > 0);
}

function inferClassification(workflow, refs, requirementRefs) {
  const explicit = normalize(workflow.classification || workflow.status || workflow.alignment);
  if (CLASSIFICATIONS.has(explicit)) return explicit;
  if (normalize(workflow.urs_scope) === "deferred" || workflow.deferred_by_urs) return "deferred_by_urs";
  if (normalize(workflow.urs_scope) === "outside" || workflow.outside_current_scope) return "outside_current_scope";
  if (workflow.future_addendum_candidate) return "future_addendum_candidate";
  if (requirementRefs.length === 0 && hasImplementation(refs)) return "future_addendum_candidate";
  if (requirementRefs.length > 0 && hasImplementation(refs) && refs.board_ticket_ids.length > 0) return "aligned";
  if (requirementRefs.length > 0) return "partial";
  return "outside_current_scope";
}

function normalizeWorkflow(workflow, index, registryRequirementIds) {
  const id = String(workflow.id || `WORKFLOW-${String(index + 1).padStart(3, "0")}`);
  const refs = implementationRefs(workflow);
  const requirementRefs = normalizeRequirementRefs(workflow);
  const classification = inferClassification(workflow, refs, requirementRefs);
  const sourceRefs = asList(workflow.source_refs || workflow.source_ref || workflow.sources || workflow.source).sort();
  const findings = [];

  if (sourceRefs.length === 0) {
    findings.push({ severity: "fail", code: "missing-source-citation", workflow_id: id, message: "Workflow row needs source_refs/source_ref." });
  }
  if (!CLASSIFICATIONS.has(classification)) {
    findings.push({ severity: "fail", code: "unknown-workflow-classification", workflow_id: id, classification, message: "Workflow classification is outside the shared vocabulary." });
  }
  for (const reqId of requirementRefs) {
    if (registryRequirementIds.size > 0 && !registryRequirementIds.has(reqId)) {
      findings.push({ severity: "fail", code: "unknown-requirement-ref", workflow_id: id, requirement_id: reqId, message: `Workflow cites unknown requirement ${reqId}.` });
    }
  }
  if (classification === "aligned" && requirementRefs.length === 0) {
    findings.push({ severity: "fail", code: "aligned-without-requirement", workflow_id: id, message: "Aligned workflow must cite a URS/requirement anchor." });
  }
  if (classification === "aligned" && !hasImplementation(refs)) {
    findings.push({ severity: "fail", code: "aligned-without-implementation", workflow_id: id, message: "Aligned workflow must cite route/page/service/API/design/ticket evidence." });
  }
  if (classification === "partial") {
    findings.push({ severity: "warning", code: "partial-workflow-gap", workflow_id: id, message: "Workflow has a URS anchor but incomplete implementation/evidence coverage." });
  }
  if (classification === "future_addendum_candidate" && requirementRefs.length === 0) {
    findings.push({ severity: "warning", code: "workflow-without-urs-anchor", workflow_id: id, message: "Implemented or proposed workflow has no current URS anchor; consider future addendum." });
  }

  return {
    id,
    title: workflow.title || workflow.name || id,
    classification,
    requirement_refs: requirementRefs,
    source_refs: sourceRefs,
    ...refs,
    findings,
  };
}

function gapWorklist(workflows) {
  return workflows
    .flatMap((workflow) =>
      workflow.findings
        .filter((finding) => finding.severity !== "info")
        .map((finding) => ({
          workflow_id: workflow.id,
          title: `Resolve ${finding.code} for ${workflow.title}`,
          classification: workflow.classification,
          finding_code: finding.code,
          source_refs: workflow.source_refs,
          dry_run: true,
        }))
    )
    .sort((a, b) => `${a.workflow_id}:${a.finding_code}`.localeCompare(`${b.workflow_id}:${b.finding_code}`));
}

function analyzeWorkflowAlignment(inventory = {}, registry = {}, options = {}) {
  const ids = registryIds(registry);
  const workflows = (inventory.workflows || [])
    .map((workflow, index) => normalizeWorkflow(workflow, index, ids))
    .sort((a, b) => a.id.localeCompare(b.id));
  const findings = workflows
    .flatMap((workflow) => workflow.findings)
    .sort((a, b) => `${a.severity}:${a.code}:${a.workflow_id}`.localeCompare(`${b.severity}:${b.code}:${b.workflow_id}`));
  const failures = findings.filter((finding) => finding.severity === "fail").length;
  return {
    kind: "concord.requirements.workflow_alignment_audit",
    schema_version: 1,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    source: {
      inventory: options.inventoryPath || "coord/.runtime/requirements/workflow-inventory.json",
      registry: options.registryPath || null,
    },
    classifications: Array.from(CLASSIFICATIONS).sort(),
    workflows: workflows.map(({ findings: _findings, ...workflow }) => workflow),
    gap_worklist: gapWorklist(workflows),
    findings,
    summary: {
      workflows: workflows.length,
      aligned: workflows.filter((workflow) => workflow.classification === "aligned").length,
      partial: workflows.filter((workflow) => workflow.classification === "partial").length,
      deferred_by_urs: workflows.filter((workflow) => workflow.classification === "deferred_by_urs").length,
      outside_current_scope: workflows.filter((workflow) => workflow.classification === "outside_current_scope").length,
      future_addendum_candidate: workflows.filter((workflow) => workflow.classification === "future_addendum_candidate").length,
      gap_worklist: gapWorklist(workflows).length,
      findings: findings.length,
      failures,
    },
    ok: failures === 0,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Workflow URS Alignment Audit");
  lines.push("");
  lines.push(`Workflows: ${report.summary.workflows}`);
  lines.push(`Aligned: ${report.summary.aligned}`);
  lines.push(`Partial: ${report.summary.partial}`);
  lines.push(`Deferred by URS: ${report.summary.deferred_by_urs}`);
  lines.push(`Outside current scope: ${report.summary.outside_current_scope}`);
  lines.push(`Future addendum candidates: ${report.summary.future_addendum_candidate}`);
  lines.push(`Gap worklist: ${report.summary.gap_worklist}`);
  lines.push("");
  lines.push("## Workflows");
  for (const workflow of report.workflows) {
    lines.push(`- ${workflow.id}: ${workflow.classification} (${workflow.requirement_refs.join(", ") || "no-urs-anchor"})`);
  }
  lines.push("");
  lines.push("## Gap Worklist");
  if (report.gap_worklist.length === 0) lines.push("None.");
  for (const gap of report.gap_worklist) lines.push(`- ${gap.workflow_id}: ${gap.finding_code} - ${gap.title}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: process.cwd(),
    inventory: "coord/.runtime/requirements/workflow-inventory.json",
    registry: null,
    output: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--dir", "--inventory", "--registry", "--output"].includes(arg)) {
      const key = arg.slice(2);
      const value = argv[++i];
      if (!value) return { error: `${arg} requires a value` };
      options[key] = value;
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  return { options };
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  if (parsed.error) {
    log(`requirements-workflow-alignment: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-workflow-alignment [--dir <root>] [--inventory <path>] [--registry <path>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const root = path.resolve(cwd, parsed.options.dir);
  const inventoryPath = path.resolve(root, parsed.options.inventory);
  if (!fs.existsSync(inventoryPath)) {
    log(`requirements-workflow-alignment: inventory not found: ${parsed.options.inventory}`);
    return { code: 1 };
  }
  const registryPath = parsed.options.registry ? path.resolve(root, parsed.options.registry) : null;
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  const registry = registryPath && fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, "utf8")) : {};
  const report = analyzeWorkflowAlignment(inventory, registry, {
    inventoryPath: parsed.options.inventory,
    registryPath: parsed.options.registry,
  });
  const body = parsed.options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (parsed.options.output) {
    const outputPath = path.resolve(root, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`, "utf8");
  } else {
    log(body);
  }
  return { code: report.ok ? 0 : 2, report };
}

module.exports = {
  CLASSIFICATIONS,
  analyzeWorkflowAlignment,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
