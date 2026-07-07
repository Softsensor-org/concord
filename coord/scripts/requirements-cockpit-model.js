#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const VIEW_DEFS = [
  {
    id: "requirements_sources",
    route: "/requirements/sources",
    title: "Requirements Sources",
    data_sources: ["coord/product/REQUIREMENTS.md", "coord/.runtime/requirements/baseline-presence.json", "coord/.runtime/requirements/registry.json"],
    copy_command: "coord requirements baseline --json --output coord/.runtime/requirements/baseline-presence.json",
  },
  {
    id: "profile_status",
    route: "/requirements/profile",
    title: "Profile Status",
    data_sources: ["coord/.runtime/requirements/registry.json", "coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md"],
    copy_command: "coord requirements --contracts --json",
  },
  {
    id: "traceability",
    route: "/requirements/traceability",
    title: "Traceability",
    data_sources: ["coord/.runtime/requirements/traceability.json", "coord/board/tasks.json", "coord/.runtime/plans"],
    copy_command: "coord requirements trace --registry coord/.runtime/requirements/registry.json --json --output coord/.runtime/requirements/traceability.json",
  },
  {
    id: "conformance",
    route: "/requirements/conformance",
    title: "Generated Conformance",
    data_sources: ["coord/rendered/requirements-conformance.md", "coord/.runtime/requirements/registry.json", "coord/board/tasks.json"],
    copy_command: "coord requirements conformance --registry coord/.runtime/requirements/registry.json --json --output coord/rendered/requirements-conformance.md",
  },
  {
    id: "surface_conformance",
    route: "/requirements/surfaces",
    title: "Persona And Surface Conformance",
    data_sources: ["coord/.runtime/requirements/surface-conformance.json", "coord/.runtime/requirements/surface-requirements.json"],
    copy_command: "coord requirements-surface-conformance --registry coord/.runtime/requirements/registry.json --json --output coord/.runtime/requirements/surface-conformance.json",
  },
  {
    id: "domain_boundary",
    route: "/requirements/domain-boundary",
    title: "Domain Ontology And Decision Boundary",
    data_sources: ["coord/.runtime/requirements/domain-boundary-report.json", "coord/.runtime/requirements/domain-boundary.json"],
    copy_command: "coord requirements-domain-boundary --json --output coord/.runtime/requirements/domain-boundary-report.json",
  },
  {
    id: "workflow_alignment",
    route: "/requirements/workflows",
    title: "Workflow Alignment",
    data_sources: ["coord/.runtime/requirements/workflow-urs-alignment.json", "coord/.runtime/requirements/workflow-inventory.json"],
    copy_command: "coord requirements workflow-align --registry coord/.runtime/requirements/registry.json --json --output coord/.runtime/requirements/workflow-urs-alignment.json",
  },
  {
    id: "donor_reuse",
    route: "/requirements/donor-reuse",
    title: "Donor Reuse",
    data_sources: ["coord/.runtime/requirements/donor-reuse-report.json", "coord/.runtime/requirements/donor-reuse-matrix.json"],
    copy_command: "coord requirements donor-analyze --json --output coord/.runtime/requirements/donor-reuse-report.json",
  },
  {
    id: "generalization_audit",
    route: "/requirements/generalization",
    title: "Generalization Audit",
    data_sources: ["coord/.runtime/requirements/generalization-audit-report.json", "coord/.runtime/requirements/generalization-audit.json"],
    copy_command: "coord requirements-generalization-audit --json --output coord/.runtime/requirements/generalization-audit-report.json",
  },
  {
    id: "deviations_waivers",
    route: "/requirements/deviations-waivers",
    title: "Deviations And Waivers",
    data_sources: ["coord/.runtime/requirements/evidence-policy.json", "coord/.runtime/requirements/registry.json"],
    copy_command: "coord requirements-evidence-policy --registry coord/.runtime/requirements/registry.json --json --output coord/.runtime/requirements/evidence-policy.json",
  },
  {
    id: "controlled_documents",
    route: "/requirements/controlled-documents",
    title: "Controlled Documents",
    data_sources: ["coord/.runtime/requirements/evidence-policy.json", "coord/.runtime/requirements/registry.json"],
    copy_command: "coord requirements-evidence-policy --registry coord/.runtime/requirements/registry.json --json --output coord/.runtime/requirements/evidence-policy.json",
  },
  {
    id: "sequencing",
    route: "/requirements/sequencing",
    title: "Sequencing Recommendations",
    data_sources: ["coord/.runtime/requirements/sequencing-plan.json", "coord/.runtime/requirements/registry.json", "coord/board/tasks.json"],
    copy_command: "coord requirements sequence --registry coord/.runtime/requirements/registry.json --json --output coord/.runtime/requirements/sequencing-plan.json",
  },
  {
    id: "stale_impact",
    route: "/requirements/stale-impact",
    title: "Stale Requirement Impact",
    data_sources: ["coord/.runtime/requirements/stale-impact.json", "coord/.runtime/requirements/registry.json"],
    copy_command: "coord requirements-stale-impact --baseline coord/.runtime/requirements/baseline-registry.json --json --output coord/.runtime/requirements/stale-impact.json",
  },
];

const DEMO_DATA_PATH = "coord/product/demo/requirements-cockpit-demo.json";

function sourceStatus(root, relPath) {
  const resolved = path.resolve(root, relPath);
  return {
    path: relPath,
    exists: fs.existsSync(resolved),
    kind: fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? "directory" : "file",
  };
}

function buildCockpitModel(options = {}) {
  const root = path.resolve(options.cwd || process.cwd(), options.dir || ".");
  const views = VIEW_DEFS.map((view) => {
    const sources = view.data_sources.map((source) => sourceStatus(root, source));
    return {
      ...view,
      read_only: true,
      command_mode: "copyable_text_only",
      mutation_allowed: false,
      source_status: sources,
      available: sources.some((source) => source.exists),
      missing_sources: sources.filter((source) => !source.exists).map((source) => source.path),
    };
  });
  return {
    kind: "concord.requirements.cockpit_model",
    schema_version: 1,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    source: {
      coord_dir: options.dir || ".",
      ui_contract: "coord/product/COORD_UI_CONTRACT.md",
      protocol: "coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md",
    },
    read_only_policy: {
      web_tier_may_write: false,
      commands_are: "copyable_text_only",
      mutation_path: "Use governed CLI tickets; cockpit views do not execute commands.",
    },
    demo_data: {
      ...sourceStatus(root, DEMO_DATA_PATH),
      canonical_source: false,
      purpose: "public-safe requirements cockpit demo story over an existing repo plus existing URS",
    },
    views,
    summary: {
      views: views.length,
      available_views: views.filter((view) => view.available).length,
      missing_all_sources: views.filter((view) => !view.available).length,
    },
  };
}

function renderMarkdown(model) {
  const lines = [];
  lines.push("# Requirements Cockpit Model");
  lines.push("");
  lines.push(`Views: ${model.summary.views}`);
  lines.push(`Available views: ${model.summary.available_views}`);
  lines.push(`Read-only: ${model.read_only_policy.web_tier_may_write === false}`);
  lines.push("");
  for (const view of model.views) {
    lines.push(`- ${view.route}: ${view.title}; command=${view.copy_command}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { dir: ".", output: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--dir", "--output"].includes(arg)) {
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
    log(`requirements-cockpit-model: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-cockpit-model [--dir <root>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const model = buildCockpitModel({ cwd, dir: parsed.options.dir });
  const body = parsed.options.json ? JSON.stringify(model, null, 2) : renderMarkdown(model);
  if (parsed.options.output) {
    const outputPath = path.resolve(cwd, parsed.options.dir, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code: 0, model };
}

module.exports = {
  VIEW_DEFS,
  buildCockpitModel,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
