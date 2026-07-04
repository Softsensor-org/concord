#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const requirementsImport = require("./requirements-import.js");
const requirementsLinkage = require("./requirements-linkage.js");
const requirementsTraceability = require("./requirements-traceability.js");
const requirementsPersonaWorkflow = require("./requirements-persona-workflow.js");
const requirementsWorkflowAlignment = require("./requirements-workflow-alignment.js");
const requirementsDonorReuse = require("./requirements-donor-reuse.js");
const requirementsReviewPack = require("./requirements-review-pack.js");
const requirementsDonorDerived = require("./requirements-donor-derived.js");
const requirementsSequencing = require("./requirements-sequencing.js");
const requirementsConformance = require("./requirements-conformance.js");
const requirementsBaselineGate = require("./requirements-baseline-gate.js");
const requirementsLinkageBackfill = require("./requirements-linkage-backfill.js");

const CONTRACTS = [
  {
    verb: "baseline",
    status: "implemented",
    default_mode: "read_only",
    implementation: "requirements-baseline-gate",
    inputs: ["canonical requirements file", "optional external source manifest", "track/profile"],
    outputs: ["requirements baseline presence gate"],
    exit_codes: { 0: "baseline acceptable for track", 1: "usage or input error", 2: "strict track baseline failure" },
    mutation_path: "Open a governed ticket to add stable IDs, declare external sources, or replace stubs.",
  },
  {
    verb: "import",
    status: "implemented",
    default_mode: "read_only",
    implementation: "requirements-import",
    inputs: ["markdown source path"],
    outputs: ["registry JSON"],
    exit_codes: { 0: "import succeeded", 1: "usage or input error" },
    mutation_path: "No mutation. Write only to an explicit derived artifact path when --output is supplied.",
  },
  {
    verb: "lint",
    status: "implemented",
    default_mode: "read_only",
    implementation: "requirements-linkage",
    inputs: ["board", "optional registry"],
    outputs: ["linkage findings"],
    exit_codes: { 0: "no blocking findings", 1: "usage or input error", 2: "regulated/profile failure" },
    mutation_path: "Open a governed ticket to add requirement ids, normalize evidence classes, or accept inferred links.",
  },
  {
    verb: "linkage-backfill",
    status: "implemented",
    default_mode: "dry_run",
    implementation: "requirements-linkage-backfill",
    inputs: ["board"],
    outputs: ["dry-run backfill report", "optional guarded board apply/revert"],
    exit_codes: { 0: "report/apply/revert succeeded", 1: "usage or input error", 2: "unsafe live-board mutation refused" },
    mutation_path: "Dry-run first; live board apply/revert requires explicit guarded invocation and governed acceptance evidence.",
  },
  {
    verb: "trace",
    status: "implemented",
    default_mode: "read_only",
    implementation: "requirements-traceability",
    inputs: ["board", "optional registry", "plan records"],
    outputs: ["traceability matrix"],
    exit_codes: { 0: "report generated", 1: "usage or input error", 2: "blocking findings" },
    mutation_path: "Open a governed ticket to update links, evidence, or requirements.",
  },
  {
    verb: "conformance",
    status: "implemented",
    default_mode: "read_only",
    implementation: "requirements-conformance",
    inputs: ["registry", "board", "plan records", "optional PRD/URS/SRS sources"],
    outputs: ["requirements conformance audit", "source hygiene findings"],
    exit_codes: { 0: "audit ok", 1: "usage or input error", 2: "hygiene, conformance, or check failure" },
    mutation_path: "Generated conformance may propose follow-up tickets; acceptance requires governed board mutation.",
  },
  {
    verb: "workflow-audit",
    status: "implemented",
    default_mode: "read_only",
    implementation: "requirements-persona-workflow",
    inputs: ["persona/workflow matrix", "board"],
    outputs: ["persona workflow audit"],
    exit_codes: { 0: "no failures", 1: "usage or input error", 2: "unknown blocker failures" },
    mutation_path: "Open a governed ticket to update persona matrices, blockers, screens, or workflow docs.",
  },
  {
    verb: "workflow-align",
    status: "implemented",
    default_mode: "read_only",
    implementation: "requirements-workflow-alignment",
    inputs: ["workflow inventory", "optional registry"],
    outputs: ["workflow URS alignment audit", "dry-run gap worklist"],
    exit_codes: { 0: "no failures", 1: "usage or input error", 2: "source/requirement failures" },
    mutation_path: "Gap worklist proposals are dry-run until accepted by a governed synthesizer ticket.",
  },
  {
    verb: "review-pack",
    status: "implemented",
    default_mode: "read_only",
    implementation: "requirements-review-pack",
    inputs: ["PRD/URS/SRS pointers", "registry", "board", "screen index", "donor reuse matrix"],
    outputs: ["multi-agent requirements review pack"],
    exit_codes: { 0: "pack emitted", 1: "usage or input error" },
    mutation_path: "Sub-agents emit findings only; one governed synthesizer ticket accepts any doc, board, prompt, or plan updates.",
  },
  {
    verb: "sequence",
    status: "implemented",
    default_mode: "dry_run",
    implementation: "requirements-sequencing",
    inputs: ["registry", "board", "plan records", "criticality", "dependencies", "inspection blockers"],
    outputs: ["risk-aware sequencing plan", "wave proposal"],
    exit_codes: { 0: "plan emitted", 1: "usage or input error" },
    mutation_path: "Sequencing proposals become board priority/dependency changes only through a governed ticket.",
  },
  {
    verb: "donor-analyze",
    status: "implemented",
    default_mode: "read_only",
    implementation: "requirements-donor-reuse",
    inputs: ["donor reuse matrix"],
    outputs: ["donor reuse report"],
    exit_codes: { 0: "no failures", 1: "usage or input error", 2: "unsafe reuse failures" },
    mutation_path: "Donor-derived backlog proposals are dry-run until accepted by a governed synthesizer ticket.",
  },
  {
    verb: "donor-derive",
    status: "implemented",
    default_mode: "read_only",
    implementation: "requirements-donor-derived",
    inputs: ["donor source inventory"],
    outputs: ["donor-to-derived-product analysis", "dry-run backlog proposals"],
    exit_codes: { 0: "analysis ok", 1: "usage or input error", 2: "scrub/provenance failures" },
    mutation_path: "Derived backlog proposals remain dry-run until a governed synthesizer ticket accepts them.",
  },
];

function contractByVerb() {
  return new Map(CONTRACTS.map((contract) => [contract.verb, contract]));
}

function contractReport() {
  return {
    kind: "concord.requirements.command_contracts",
    schema_version: 1,
    default_policy: "read-only or dry-run; no board mutation from protocol commands",
    mutation_escalation: "Use a governed ticket and single writer to accept generated docs, links, board rows, priorities, dependencies, waivers, or closures.",
    commands: CONTRACTS,
  };
}

function renderContracts(report = contractReport()) {
  const lines = [];
  lines.push("# Requirements Command Contracts");
  lines.push("");
  lines.push(`Default policy: ${report.default_policy}`);
  lines.push(`Mutation escalation: ${report.mutation_escalation}`);
  lines.push("");
  for (const command of report.commands) {
    lines.push(`## requirements ${command.verb}`);
    lines.push("");
    lines.push(`Status: ${command.status}`);
    lines.push(`Default mode: ${command.default_mode}`);
    lines.push(`Implementation: ${command.implementation || "contract-only stub"}`);
    lines.push(`Inputs: ${command.inputs.join(", ")}`);
    lines.push(`Outputs: ${command.outputs.join(", ")}`);
    lines.push(`Mutation path: ${command.mutation_path}`);
    lines.push("");
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { json: false, output: null, contract: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--contracts" || arg === "contracts") {
      options.contract = true;
      continue;
    }
    if (arg === "--output") {
      options.output = argv[++i];
      if (!options.output) return { error: "--output requires a value" };
      continue;
    }
    rest.push(arg);
  }
  return { options, rest };
}

function writeOrLog(body, output, cwd, log) {
  if (!output) {
    log(body);
    return;
  }
  const outputPath = path.resolve(cwd, output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${body}\n`);
}

function emitStub(contract, options, deps) {
  const report = {
    kind: "concord.requirements.command_stub",
    schema_version: 1,
    verb: contract.verb,
    status: contract.status,
    default_mode: contract.default_mode,
    inputs: contract.inputs,
    outputs: contract.outputs,
    mutation_path: contract.mutation_path,
    dry_run: true,
  };
  const body = options.json ? JSON.stringify(report, null, 2) : renderContracts({ ...contractReport(), commands: [contract] });
  writeOrLog(body, options.output, deps.cwd || process.cwd(), deps.log || console.log);
  return { code: 0, report };
}

function run(argv = [], deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  const parsed = parseArgs(argv);
  if (parsed.error) {
    log(`requirements: ${parsed.error}`);
    return { code: 1 };
  }
  const [verb, ...rest] = parsed.rest;
  if (!verb || verb === "--help" || verb === "-h" || parsed.options.contract) {
    const report = contractReport();
    const body = parsed.options.json ? JSON.stringify(report, null, 2) : renderContracts(report);
    writeOrLog(body, parsed.options.output, deps.cwd || process.cwd(), log);
    return { code: 0, report };
  }
  const contract = contractByVerb().get(verb);
  if (!contract) {
    log(`requirements: unknown verb '${verb}'`);
    log(`Known verbs: ${CONTRACTS.map((item) => item.verb).join(", ")}`);
    return { code: 1 };
  }
  if (verb === "import") return requirementsImport.run(rest, deps);
  if (verb === "baseline") {
    const forwarded = rest.slice();
    if (parsed.options.json && !forwarded.includes("--json")) forwarded.push("--json");
    if (parsed.options.output && !forwarded.includes("--output")) forwarded.push("--output", parsed.options.output);
    return requirementsBaselineGate.run(forwarded, deps);
  }
  if (verb === "lint") return requirementsLinkage.run(rest, deps);
  if (verb === "linkage-backfill") {
    const forwarded = rest.slice();
    if (parsed.options.json && !forwarded.includes("--json")) forwarded.push("--json");
    if (parsed.options.output && !forwarded.includes("--output")) forwarded.push("--output", parsed.options.output);
    return requirementsLinkageBackfill.run(forwarded, deps);
  }
  if (verb === "trace") return requirementsTraceability.run(rest, deps);
  if (verb === "conformance") {
    const forwarded = rest.slice();
    if (parsed.options.json && !forwarded.includes("--json")) forwarded.push("--json");
    if (parsed.options.output && !forwarded.includes("--output")) forwarded.push("--output", parsed.options.output);
    return requirementsConformance.run(forwarded, deps);
  }
  if (verb === "workflow-audit") return requirementsPersonaWorkflow.run(rest, deps);
  if (verb === "workflow-align") return requirementsWorkflowAlignment.run(rest, deps);
  if (verb === "review-pack") return requirementsReviewPack.run(rest, deps);
  if (verb === "sequence") {
    const forwarded = rest.slice();
    if (parsed.options.json && !forwarded.includes("--json")) forwarded.push("--json");
    if (parsed.options.output && !forwarded.includes("--output")) forwarded.push("--output", parsed.options.output);
    return requirementsSequencing.run(forwarded, deps);
  }
  if (verb === "donor-analyze") return requirementsDonorReuse.run(rest, deps);
  if (verb === "donor-derive") return requirementsDonorDerived.run(rest, deps);
  return emitStub(contract, parsed.options, deps);
}

module.exports = {
  CONTRACTS,
  contractReport,
  renderContracts,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
