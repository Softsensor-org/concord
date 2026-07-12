"use strict";

const PRODUCT_COMMANDS = [
  {
    name: "affected-targets",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only",
    summary: "Select dependency-affected gate targets from changed files with conservative full fallback.",
    docs: "coord/product/TESTING_AND_GATES.md",
    ui_palette: true,
  },
  {
    name: "authority-check",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only",
    summary: "Detect canonical/derived state authority inversions such as rendered views used as mutation authority.",
    docs: "coord/product/CANONICAL_DERIVED_AUTHORITY.md",
    ui_palette: true,
  },
  {
    name: "adr-validate",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Validate ADR registry numbering, index links, status vocabulary, required sections, and supersession consistency.",
    docs: "coord/docs/decisions/README.md",
    ui_palette: true,
  },
  {
    name: "business-discovery",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Run source-backed existing-repo business discovery into a derived artifact.",
    docs: "coord/product/BUSINESS_DISCOVERY_PROTOCOL.md",
    ui_palette: true,
  },
  {
    name: "business-context-pack",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Generate ticket-specific business context packs from discovery synthesis artifacts.",
    docs: "coord/product/BUSINESS_DISCOVERY_PROTOCOL.md",
    ui_palette: true,
  },
  {
    name: "business-discovery-synthesize",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Synthesize a business-discovery run into cited context graph and promoted doc drafts.",
    docs: "coord/product/BUSINESS_DISCOVERY_PROTOCOL.md",
    ui_palette: true,
  },
  {
    name: "commands",
    namespace: "product",
    maturity: "stable",
    safety: "read_only",
    summary: "Generate the machine-readable command registry or markdown reference.",
    docs: "coord/scripts/README.md#product-cli-coord",
    ui_palette: true,
  },
  {
    name: "conformance",
    namespace: "product",
    maturity: "stable",
    safety: "read_only_or_local_attestation",
    summary: "Verify engine conformance (journal chain self-verify; --attest/--verify signed attestation).",
    docs: "coord/scripts/README.md#product-cli-coord",
    ui_palette: true,
  },
  {
    name: "doctor",
    namespace: "product",
    maturity: "stable",
    safety: "read_only",
    summary: "Read-only repo adoption/readiness report (profile, gaps, suggested tickets).",
    docs: "coord/product/SOFTSENSORAI_DONOR_LESSONS.md",
    ui_palette: true,
  },
  {
    name: "exploration-promote",
    namespace: "product",
    maturity: "alpha",
    safety: "dry_run",
    summary: "Promote exploration findings into governed ticket specs without board mutation.",
    docs: "coord/product/SOFTSENSORAI_DONOR_LESSONS.md",
    ui_palette: true,
  },
  {
    name: "init",
    namespace: "product",
    maturity: "stable",
    safety: "no_clobber_write",
    summary: "Bootstrap a repo into a governed-board layout (idempotent, no-clobber).",
    docs: "coord/scripts/README.md#product-cli-coord",
    ui_palette: true,
  },
  {
    name: "onboard",
    namespace: "product",
    maturity: "alpha",
    safety: "dry_run_or_no_clobber_write",
    summary: "Generate an adoption plan for an existing repo, including repo shape, track preset, starter tickets, and setup artifacts.",
    docs: "QUICKSTART.md",
    ui_palette: true,
  },
  {
    name: "track-presets",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only",
    summary: "List ready-made governance track presets for web app, data service, content site, and infra projects.",
    docs: "coord/product/MULTI_TRACK_GOVERNANCE_PROFILE.md",
    ui_palette: true,
  },
  {
    name: "knowledge-claim-compile",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Gate proposed knowledge claims into accepted, candidate, rejected, conflicted, superseded, or review-required outcomes.",
    docs: "coord/docs/MEMORY_ARCHITECTURE.md",
    ui_palette: true,
  },
  {
    name: "requirements",
    namespace: "product",
    maturity: "planned_surface",
    safety: "read_only_or_dry_run",
    summary: "Requirements Assurance Protocol umbrella commands and contracts.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md",
    ui_palette: true,
  },
  {
    name: "requirements-artifacts",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Emit or validate the Requirements Assurance Protocol artifact model.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md",
    ui_palette: true,
  },
  {
    name: "requirements-conformance",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Generate requirements conformance from board, plans, evidence, traceability, and requirements-source hygiene.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md",
    ui_palette: true,
  },
  {
    name: "requirements-baseline-gate",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Check whether a repo has a real requirements baseline, stable IDs, source declarations, or an external authoritative pointer.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md",
    ui_palette: true,
  },
  {
    name: "requirements-cockpit-model",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Emit the read-only Requirements Assurance cockpit view model and copyable command catalog.",
    docs: "coord/product/COORD_UI_CONTRACT.md",
    ui_palette: true,
  },
  {
    name: "requirements-donor-reuse",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Validate donor/legacy reuse decisions, provenance, scrub, and generalization status.",
    docs: "coord/product/REQUIREMENTS_REGISTRY_SCHEMA.md",
    ui_palette: true,
  },
  {
    name: "requirements-domain-boundary",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Lint domain ontology, decision authority, source evidence, contradictions, and investigation workflow coverage.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PLAN.md",
    ui_palette: true,
  },
  {
    name: "requirements-generalization-audit",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Audit donor/legacy residue against owning abstractions, scrub status, provenance, and governed worklist.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PLAN.md",
    ui_palette: true,
  },
  {
    name: "requirements-donor-derived",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Analyze donor repo-family inventories into generalized concepts, residue findings, evidence, and dry-run backlog proposals.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PLAN.md",
    ui_palette: true,
  },
  {
    name: "requirements-evidence-policy",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Evaluate requirement evidence classes against risk/profile policy.",
    docs: "coord/product/REQUIREMENTS_REGISTRY_SCHEMA.md",
    ui_palette: true,
  },
  {
    name: "requirements-import",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_stdout",
    summary: "Import explicit markdown PRD/URS requirement headings into registry JSON.",
    docs: "coord/product/REQUIREMENTS_REGISTRY_SCHEMA.md",
    ui_palette: true,
  },
  {
    name: "requirements-linkage",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only",
    summary: "Validate ticket-to-requirement links from board fields and requirement labels.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PLAN.md",
    ui_palette: true,
  },
  {
    name: "requirements-linkage-backfill",
    namespace: "product",
    maturity: "alpha",
    safety: "dry_run_or_guarded_write",
    summary: "Backfill explicit Requirement IDs from existing ticket descriptions with idempotent apply/revert safeguards.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PLAN.md",
    ui_palette: false,
  },
  {
    name: "requirements-persona-workflow",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Audit persona/workflow matrix coverage and blocker references.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PLAN.md",
    ui_palette: true,
  },
  {
    name: "requirements-workflow-alignment",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Audit workflow inventories against URS requirement anchors and emit a dry-run gap worklist.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PLAN.md",
    ui_palette: true,
  },
  {
    name: "requirements-review-pack",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Emit the read-only multi-agent requirements review lenses and governed synthesizer contract.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md",
    ui_palette: true,
  },
  {
    name: "requirements-sequencing",
    namespace: "product",
    maturity: "alpha",
    safety: "dry_run_or_explicit_output",
    summary: "Generate a risk-before-feature-value requirements sequencing plan with dependency reasons.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PLAN.md",
    ui_palette: true,
  },
  {
    name: "requirements-screen-coverage",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Report screen-to-requirement coverage from a derived screen index.",
    docs: "coord/product/SCREEN_INDEX_CONTRACT.md",
    ui_palette: true,
  },
  {
    name: "requirements-stale-impact",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Compare baseline/current requirement block hashes and report impacted tickets, screens, and evidence.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PLAN.md",
    ui_palette: true,
  },
  {
    name: "requirements-surface-conformance",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Generate cross-surface conformance and shared-contract gaps for persona/app requirement sources.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md",
    ui_palette: true,
  },
  {
    name: "requirements-traceability",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Generate deterministic requirements traceability matrix artifacts.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PLAN.md",
    ui_palette: true,
  },
  {
    name: "requirements-walking-skeleton",
    namespace: "product",
    maturity: "alpha",
    safety: "read_only_or_explicit_output",
    summary: "Run the fixture-backed requirements import/link/trace/readout proof.",
    docs: "coord/product/REQUIREMENTS_ASSURANCE_PLAN.md",
    ui_palette: true,
  },
  {
    name: "upgrade",
    namespace: "product",
    maturity: "stable",
    safety: "managed_write_with_rollback",
    summary: "Plan the latest pinned-channel engine update, apply only its reviewed digest, re-pin + verify, and roll back on failure.",
    docs: "coord/scripts/README.md#product-cli-coord",
    ui_palette: false,
  },
];

const GOVERNANCE_COMMANDS = [
  {
    name: "adr",
    namespace: "governance",
    maturity: "alpha",
    safety: "governance_mutation",
    summary: "List, show, validate, create, link, and supersede governed ADR records through the journaled mutation path.",
    docs: "coord/docs/decisions/README.md",
    ui_palette: false,
  },
  {
    name: "start",
    namespace: "governance",
    maturity: "existing_lifecycle",
    safety: "governance_mutation",
    summary: "Start a governed ticket and acquire its lock.",
    docs: "coord/GOVERNANCE.md",
    ui_palette: false,
  },
  {
    name: "submit",
    namespace: "governance",
    maturity: "existing_lifecycle",
    safety: "governance_mutation",
    summary: "Move a ticket from doing to review after evidence gates pass.",
    docs: "coord/GOVERNANCE.md",
    ui_palette: false,
  },
  {
    name: "finalize",
    namespace: "governance",
    maturity: "existing_lifecycle",
    safety: "governance_mutation",
    summary: "Finalize reviewed work and sync board artifacts.",
    docs: "coord/GOVERNANCE.md",
    ui_palette: false,
  },
  {
    name: "merge-queue",
    namespace: "governance",
    maturity: "alpha",
    safety: "governance_mutation",
    summary: "Inspect or record the contention-triggered merge queue for overlapping land/finalize work.",
    docs: "coord/scripts/README.md",
    ui_palette: false,
  },
  {
    name: "guided-closeout",
    namespace: "governance",
    maturity: "alpha",
    safety: "read_only_or_runtime_receipt",
    summary: "Report closeout evidence gaps and exact remediation commands before submit/finalize.",
    docs: "coord/GOVERNANCE.md",
    ui_palette: false,
  },
  {
    name: "governance-tier",
    namespace: "governance",
    maturity: "alpha",
    safety: "read_only",
    summary: "Show active progressive-disclosure governance tier and its required gates.",
    docs: "coord/GOVERNANCE.md",
    ui_palette: false,
  },
  {
    name: "publishability-check",
    namespace: "governance",
    maturity: "alpha",
    safety: "read_only",
    summary: "Determine whether touched files require release hygiene evidence at closeout.",
    docs: "coord/product/TESTING_AND_GATES.md",
    ui_palette: false,
  },
];

const ADOPTION_GOVERNANCE_COMMAND_NAMES = Object.freeze([
  "guided-closeout",
  "governance-tier",
  "publishability-check",
]);

function runAdoptionGovernanceCommand(name, args = [], parseFlags) {
  if (!ADOPTION_GOVERNANCE_COMMAND_NAMES.includes(name)) {
    throw new Error(`Unknown adoption governance command "${name}".`);
  }
  if (typeof parseFlags !== "function") {
    throw new Error("runAdoptionGovernanceCommand requires parseFlags.");
  }
  if (name === "guided-closeout") {
    const { guidedCloseoutCommand } = require("./guided-closeout.js");
    return guidedCloseoutCommand(args[0], parseFlags(args.slice(1)));
  }
  if (name === "governance-tier") {
    const { governanceTierCommand } = require("./governance-tier.js");
    return governanceTierCommand(parseFlags(args));
  }
  const { publishabilityCheckCommand } = require("./publishability-check.js");
  return publishabilityCheckCommand(args[0], parseFlags(args.slice(1)));
}

function sorted(commands) {
  return commands.slice().sort((a, b) => `${a.namespace}:${a.name}`.localeCompare(`${b.namespace}:${b.name}`));
}

function listCommandMetadata(options = {}) {
  const includeGovernance = options.includeGovernance !== false;
  return sorted(includeGovernance ? PRODUCT_COMMANDS.concat(GOVERNANCE_COMMANDS) : PRODUCT_COMMANDS);
}

function productCommandMetadataByName() {
  return new Map(PRODUCT_COMMANDS.map((command) => [command.name, command]));
}

function productSummary(name) {
  const command = productCommandMetadataByName().get(name);
  if (!command) throw new Error(`Missing product command metadata for ${name}`);
  return command.summary;
}

function commandRegistryReport(options = {}) {
  return {
    kind: "concord.command_registry",
    schema_version: 1,
    commands: listCommandMetadata({ includeGovernance: options.includeGovernance !== false }),
  };
}

function renderCommandReference(report = commandRegistryReport()) {
  const lines = [];
  lines.push("# Concord Command Reference");
  lines.push("");
  for (const command of report.commands) {
    lines.push(`## ${command.namespace}:${command.name}`);
    lines.push("");
    lines.push(`Maturity: ${command.maturity}`);
    lines.push(`Safety: ${command.safety}`);
    lines.push(`Summary: ${command.summary}`);
    lines.push(`Docs: ${command.docs}`);
    lines.push(`UI palette: ${command.ui_palette ? "yes" : "no"}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function run(argv = [], deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  let json = false;
  let includeGovernance = true;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--product-only") {
      includeGovernance = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      log("Usage: coord commands [--json] [--product-only]");
      return { code: 0 };
    }
    log(`commands: unexpected argument ${arg}`);
    return { code: 1 };
  }
  const report = commandRegistryReport({ includeGovernance });
  log(json ? JSON.stringify(report, null, 2) : renderCommandReference(report));
  return { code: 0, report };
}

module.exports = {
  ADOPTION_GOVERNANCE_COMMAND_NAMES,
  GOVERNANCE_COMMANDS,
  PRODUCT_COMMANDS,
  commandRegistryReport,
  listCommandMetadata,
  productCommandMetadataByName,
  productSummary,
  renderCommandReference,
  runAdoptionGovernanceCommand,
  run,
};
