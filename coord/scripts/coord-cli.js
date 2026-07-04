#!/usr/bin/env node
"use strict";

// COORD-116: the PRODUCT-facing `coord` CLI dispatcher.
//
// This is the packaged product surface (`coord init`, and later COORD-117
// `coord conformance` / COORD-118 `coord upgrade`), distinct from the per-ticket
// governance ENGINE CLI (`coord/scripts/gov` → governance.js → cli.js, which
// dispatches the lifecycle verbs start/commit/finalize/conform/…).
//
// Design: a small COMMAND REGISTRY — a map of { name -> { summary, run(args) } }.
// `coord` / `coord help` prints the usage listing; an unknown command errors
// with exit 1. Adding a subcommand is a one-line registry entry + a module:
//
//     conformance: { summary: "...", run: (args) => createConformance().run(args) }
//
// The dispatch logic is kept in a pure-ish `dispatch(registry, argv, deps)` so
// it is unit-testable without spawning a process: routing, help, and the
// unknown-command path all return a { code, ... } result instead of calling
// process.exit directly.

const createCoordInit = require("./coord-init.js");
const createCoordConformance = require("./coord-conformance.js");
const createCoordUpgrade = require("./coord-upgrade.js");
const createReadinessDoctor = require("./readiness-doctor.js");
const requirementsImport = require("./requirements-import.js");
const requirementsLinkage = require("./requirements-linkage.js");
const requirementsTraceability = require("./requirements-traceability.js");
const requirementsScreenCoverage = require("./requirements-screen-coverage.js");
const requirementsPersonaWorkflow = require("./requirements-persona-workflow.js");
const requirementsWorkflowAlignment = require("./requirements-workflow-alignment.js");
const requirementsEvidencePolicy = require("./requirements-evidence-policy.js");
const requirementsDonorReuse = require("./requirements-donor-reuse.js");
const requirementsDonorDerived = require("./requirements-donor-derived.js");
const requirementsCommandContracts = require("./requirements-command-contracts.js");
const requirementsArtifactModel = require("./requirements-artifact-model.js");
const requirementsWalkingSkeleton = require("./requirements-walking-skeleton.js");
const requirementsReviewPack = require("./requirements-review-pack.js");
const requirementsSequencing = require("./requirements-sequencing.js");
const requirementsConformance = require("./requirements-conformance.js");
const requirementsSurfaceConformance = require("./requirements-surface-conformance.js");
const requirementsCockpitModel = require("./requirements-cockpit-model.js");
const requirementsDomainBoundary = require("./requirements-domain-boundary.js");
const requirementsStaleImpact = require("./requirements-stale-impact.js");
const requirementsGeneralizationAudit = require("./requirements-generalization-audit.js");
const requirementsBaselineGate = require("./requirements-baseline-gate.js");
const requirementsLinkageBackfill = require("./requirements-linkage-backfill.js");
const commandRegistry = require("./command-registry.js");
const adrValidator = require("./adr-validator.js");
const explorationPromotion = require("./exploration-promotion.js");
const businessContextPack = require("./business-context-pack.js");
const businessDiscovery = require("./business-discovery.js");
const businessDiscoverySynthesize = require("./business-discovery-synthesize.js");
const knowledgeClaimCompiler = require("./knowledge-claim-compiler.js");
const affectedTargets = require("./affected-targets.js");
const canonicalDerivedAuthority = require("./canonical-derived-authority.js");
const onboard = require("./onboard.js");
const trackPresets = require("./track-presets.js");

// Build the command registry. Factored so tests can build a registry with
// injected deps (fs/log/cwd) and assert routing without touching the real repo.
function buildRegistry(deps = {}) {
  const init = createCoordInit(deps);
  const conformance = createCoordConformance(deps);
  const upgrade = createCoordUpgrade(deps);
  const doctor = createReadinessDoctor(deps);
  return {
    "affected-targets": {
      summary: commandRegistry.productSummary("affected-targets"),
      run: (args) => {
        const result = affectedTargets.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "adr-validate": {
      summary: commandRegistry.productSummary("adr-validate"),
      run: (args) => {
        const result = adrValidator.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    commands: {
      summary: commandRegistry.productSummary("commands"),
      run: (args) => {
        const result = commandRegistry.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "business-discovery": {
      summary: commandRegistry.productSummary("business-discovery"),
      run: (args) => {
        const result = businessDiscovery.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "business-context-pack": {
      summary: commandRegistry.productSummary("business-context-pack"),
      run: (args) => {
        const result = businessContextPack.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "business-discovery-synthesize": {
      summary: commandRegistry.productSummary("business-discovery-synthesize"),
      run: (args) => {
        const result = businessDiscoverySynthesize.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "authority-check": {
      summary: commandRegistry.productSummary("authority-check"),
      run: (args) => {
        const result = canonicalDerivedAuthority.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    doctor: {
      summary: commandRegistry.productSummary("doctor"),
      run: (args) => {
        const result = doctor.run(args);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "exploration-promote": {
      summary: commandRegistry.productSummary("exploration-promote"),
      run: (args) => {
        const result = explorationPromotion.run(args);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    init: {
      summary: commandRegistry.productSummary("init"),
      run: (args) => {
        const result = init.run(args);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    onboard: {
      summary: commandRegistry.productSummary("onboard"),
      run: (args) => {
        const result = onboard.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "track-presets": {
      summary: commandRegistry.productSummary("track-presets"),
      run: (args) => {
        const result = trackPresets.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "knowledge-claim-compile": {
      summary: commandRegistry.productSummary("knowledge-claim-compile"),
      run: (args) => {
        const result = knowledgeClaimCompiler.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-import": {
      summary: commandRegistry.productSummary("requirements-import"),
      run: (args) => {
        const result = requirementsImport.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    requirements: {
      summary: commandRegistry.productSummary("requirements"),
      run: (args) => {
        const result = requirementsCommandContracts.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-linkage": {
      summary: commandRegistry.productSummary("requirements-linkage"),
      run: (args) => {
        const result = requirementsLinkage.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-linkage-backfill": {
      summary: commandRegistry.productSummary("requirements-linkage-backfill"),
      run: (args) => {
        const result = requirementsLinkageBackfill.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-conformance": {
      summary: commandRegistry.productSummary("requirements-conformance"),
      run: (args) => {
        const result = requirementsConformance.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-baseline-gate": {
      summary: commandRegistry.productSummary("requirements-baseline-gate"),
      run: (args) => {
        const result = requirementsBaselineGate.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-cockpit-model": {
      summary: commandRegistry.productSummary("requirements-cockpit-model"),
      run: (args) => {
        const result = requirementsCockpitModel.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-traceability": {
      summary: commandRegistry.productSummary("requirements-traceability"),
      run: (args) => {
        const result = requirementsTraceability.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-screen-coverage": {
      summary: commandRegistry.productSummary("requirements-screen-coverage"),
      run: (args) => {
        const result = requirementsScreenCoverage.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-stale-impact": {
      summary: commandRegistry.productSummary("requirements-stale-impact"),
      run: (args) => {
        const result = requirementsStaleImpact.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-surface-conformance": {
      summary: commandRegistry.productSummary("requirements-surface-conformance"),
      run: (args) => {
        const result = requirementsSurfaceConformance.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-persona-workflow": {
      summary: commandRegistry.productSummary("requirements-persona-workflow"),
      run: (args) => {
        const result = requirementsPersonaWorkflow.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-workflow-alignment": {
      summary: commandRegistry.productSummary("requirements-workflow-alignment"),
      run: (args) => {
        const result = requirementsWorkflowAlignment.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-evidence-policy": {
      summary: commandRegistry.productSummary("requirements-evidence-policy"),
      run: (args) => {
        const result = requirementsEvidencePolicy.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-donor-reuse": {
      summary: commandRegistry.productSummary("requirements-donor-reuse"),
      run: (args) => {
        const result = requirementsDonorReuse.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-domain-boundary": {
      summary: commandRegistry.productSummary("requirements-domain-boundary"),
      run: (args) => {
        const result = requirementsDomainBoundary.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-generalization-audit": {
      summary: commandRegistry.productSummary("requirements-generalization-audit"),
      run: (args) => {
        const result = requirementsGeneralizationAudit.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-donor-derived": {
      summary: commandRegistry.productSummary("requirements-donor-derived"),
      run: (args) => {
        const result = requirementsDonorDerived.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-artifacts": {
      summary: commandRegistry.productSummary("requirements-artifacts"),
      run: (args) => {
        const result = requirementsArtifactModel.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-walking-skeleton": {
      summary: commandRegistry.productSummary("requirements-walking-skeleton"),
      run: (args) => {
        const result = requirementsWalkingSkeleton.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-review-pack": {
      summary: commandRegistry.productSummary("requirements-review-pack"),
      run: (args) => {
        const result = requirementsReviewPack.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    "requirements-sequencing": {
      summary: commandRegistry.productSummary("requirements-sequencing"),
      run: (args) => {
        const result = requirementsSequencing.run(args, deps);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    conformance: {
      summary: commandRegistry.productSummary("conformance"),
      run: (args) => {
        const result = conformance.run(args);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    upgrade: {
      summary: commandRegistry.productSummary("upgrade"),
      run: (args) => {
        const result = upgrade.run(args);
        return { code: result.code != null ? result.code : 0 };
      },
    },
  };
}

function printUsage(registry, log) {
  log("coord — governed project CLI");
  log("");
  log("Usage: coord <command> [options]");
  log("");
  log("Commands:");
  const names = Object.keys(registry).sort();
  const width = names.reduce((max, n) => Math.max(max, n.length), 0);
  for (const name of names) {
    log(`  ${name.padEnd(width)}  ${registry[name].summary}`);
  }
  log(`  ${"help".padEnd(width)}  Show this help text.`);
  log("");
  log("Run `coord <command> --help` for command-specific options.");
}

// Pure-ish dispatch: route argv to a registered command. Returns { code }.
// Never calls process.exit so it is unit-testable.
function dispatch(argv = [], deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  const registry = deps.registry || buildRegistry(deps);

  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage(registry, log);
    return { code: 0 };
  }

  const entry = registry[command];
  if (!entry) {
    log(`coord: unknown command '${command}'`);
    log("Run `coord help` for the list of commands.");
    return { code: 1 };
  }

  return entry.run(rest);
}

module.exports = { dispatch, buildRegistry, printUsage };

// CLI entrypoint (only when run directly, not when required by tests).
if (require.main === module) {
  const result = dispatch(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
