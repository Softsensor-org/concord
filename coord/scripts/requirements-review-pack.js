#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LENSES = [
  {
    id: "persona",
    title: "Persona and role coverage",
    objective: "Find missing, conflicting, or under-specified user roles, personas, permissions, and handoffs.",
    read_only_inputs: ["PRD/URS/SRS", "persona matrix", "board", "role/RBAC docs"],
    finding_focus: ["missing persona", "unclear owner", "role mismatch", "workflow handoff gap"],
  },
  {
    id: "workflow",
    title: "Workflow coverage",
    objective: "Trace each core workflow from trigger to closure and identify incomplete states, edges, or exception paths.",
    read_only_inputs: ["requirements registry", "workflow matrix", "board dependencies", "process docs"],
    finding_focus: ["missing state", "unclear transition", "exception path", "blocked workflow"],
  },
  {
    id: "screen",
    title: "Screen and route coverage",
    objective: "Check whether requirements have inspectable screens, routes, navigation anchors, and rendered acceptance evidence.",
    read_only_inputs: ["screen index", "route inventory", "UI contract", "screenshots or rendered QA output"],
    finding_focus: ["missing screen", "unlinked route", "persona-screen mismatch", "rendered evidence gap"],
  },
  {
    id: "backend_api",
    title: "Backend, API, and service coverage",
    objective: "Check whether user-visible requirements have backend/API/service contracts and integration evidence.",
    read_only_inputs: ["API docs", "OpenAPI/GraphQL schemas", "service inventory", "board and plan records"],
    finding_focus: ["missing endpoint", "contract mismatch", "unowned service", "integration gap"],
  },
  {
    id: "data_event",
    title: "Data, event, and migration coverage",
    objective: "Find missing data contracts, event semantics, migration/backfill proof, and source-of-truth ambiguity.",
    read_only_inputs: ["data contracts", "event schemas", "migration notes", "runtime/deploy evidence"],
    finding_focus: ["missing data contract", "event ambiguity", "backfill risk", "source-of-truth gap"],
  },
  {
    id: "security_rbac",
    title: "Security, RBAC, audit, and tenant boundary coverage",
    objective: "Check identity, authorization, audit trail, secret handling, tenant isolation, and redaction requirements.",
    read_only_inputs: ["security requirements", "RBAC matrix", "audit policy", "deployment profile"],
    finding_focus: ["authn gap", "authorization gap", "audit evidence gap", "tenant isolation gap"],
  },
  {
    id: "evidence_test",
    title: "Evidence, test, runtime, and deployment proof coverage",
    objective: "Verify each requirement has evidence class appropriate to risk, including runtime/deploy proof where needed.",
    read_only_inputs: ["test plans", "evidence policy", "plan records", "runtime receipts", "deploy receipts"],
    finding_focus: ["missing test", "wrong evidence class", "readyz-only proof", "runtime proof gap"],
  },
  {
    id: "donor_reuse",
    title: "Donor reuse and generalization coverage",
    objective: "Check donor-derived material for provenance, scrub status, generalization decision, and unsafe carryover.",
    read_only_inputs: ["donor reuse matrix", "source inventory", "public-cut rules", "derived product baseline"],
    finding_focus: ["missing provenance", "needs scrub", "needs generalization", "unsafe reuse"],
  },
];

const FINDING_SCHEMA = {
  required_fields: [
    "lens_id",
    "severity",
    "requirement_id",
    "summary",
    "source_citations",
    "evidence",
    "recommended_action",
  ],
  severity_values: ["fail", "warning", "info"],
  source_citation_rule: "Cite paths, anchors, requirement ids, ticket ids, screen ids, API ids, or private:// pointers; do not copy private source bodies.",
  mutation_rule: "Sub-agents emit findings only. They must not edit docs, board rows, prompts, plan records, generated artifacts, or source code.",
};

const SYNTHESIZER = {
  id: "governed_requirements_synthesizer",
  writer_policy: "single governed writer only",
  accepts: ["sub-agent finding JSON", "source citations", "explicit confidence/risk labels"],
  rejects: ["uncited findings", "private source bodies in public artifacts", "board/doc mutations by sub-agents"],
  outputs: [
    "requirements audit",
    "requirements delta",
    "persona blocker table",
    "screen coverage worklist",
    "dry-run ticket proposals",
  ],
  mutation_path: "Open or use one governed ticket. The synthesizer alone updates canonical docs, board rows, prompts, and plan records.",
  gates: [
    "board validation",
    "artifact public-boundary scan",
    "source citation check",
    "human confirmation for inferred or donor-derived requirements",
  ],
};

function reviewPack(options = {}) {
  const project = options.project || "existing-repo";
  return {
    kind: "concord.requirements.multi_agent_review_pack",
    schema_version: 1,
    project,
    source: {
      inputs: [
        "coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md#sub-agent-review-model",
        "coord/product/REQUIREMENTS_ASSURANCE_PLAN.md#multi-agent-requirements-review-model",
      ],
      citation_policy: "Sub-agent findings must cite source paths, anchors, ids, or private:// pointers.",
    },
    safety_model: {
      sub_agents: "read_only_findings_only",
      synthesizer: "single_governed_writer",
      concurrency: "parallel reads allowed; governance mutations serialized through one ticket/worktree",
    },
    deterministic_rules: [
      "Sort findings by severity, lens_id, requirement_id, and source citation.",
      "Require source citations for every finding.",
      "Mark inferred links as inferred until human-confirmed.",
      "Use private:// pointers for sensitive donor or customer source material.",
    ],
    lenses: LENSES,
    finding_schema: FINDING_SCHEMA,
    synthesizer: SYNTHESIZER,
  };
}

function renderMarkdown(pack = reviewPack()) {
  const lines = [];
  lines.push("# Multi-Agent Requirements Review Pack");
  lines.push("");
  lines.push(`Project: ${pack.project}`);
  lines.push("");
  lines.push("## Safety Model");
  lines.push("");
  lines.push(`- Sub-agents: ${pack.safety_model.sub_agents}`);
  lines.push(`- Synthesizer: ${pack.safety_model.synthesizer}`);
  lines.push(`- Concurrency: ${pack.safety_model.concurrency}`);
  lines.push("");
  lines.push("## Lenses");
  for (const lens of pack.lenses) {
    lines.push("");
    lines.push(`### ${lens.id}: ${lens.title}`);
    lines.push("");
    lines.push(lens.objective);
    lines.push("");
    lines.push(`Inputs: ${lens.read_only_inputs.join(", ")}`);
    lines.push(`Focus: ${lens.finding_focus.join(", ")}`);
  }
  lines.push("");
  lines.push("## Finding Schema");
  lines.push("");
  lines.push(`Required fields: ${pack.finding_schema.required_fields.join(", ")}`);
  lines.push(`Citation rule: ${pack.finding_schema.source_citation_rule}`);
  lines.push(`Mutation rule: ${pack.finding_schema.mutation_rule}`);
  lines.push("");
  lines.push("## Synthesizer");
  lines.push("");
  lines.push(`Writer policy: ${pack.synthesizer.writer_policy}`);
  lines.push(`Mutation path: ${pack.synthesizer.mutation_path}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { json: false, output: null, project: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--output", "--project"].includes(arg)) {
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
    log(`requirements-review-pack: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-review-pack [--project <name>] [--json] [--output <path>]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const pack = reviewPack({ project: parsed.options.project });
  const body = parsed.options.json ? JSON.stringify(pack, null, 2) : renderMarkdown(pack);
  if (parsed.options.output) {
    const outputPath = path.resolve(cwd, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`, "utf8");
  } else {
    log(body);
  }
  return { code: 0, report: pack };
}

module.exports = {
  LENSES,
  FINDING_SCHEMA,
  SYNTHESIZER,
  reviewPack,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
