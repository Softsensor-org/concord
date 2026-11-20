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

const { resolveEngineModule } = require("../../paths.js");
const COORD_DIR = require("node:path").resolve(__dirname, "..", "..");
const createCoordInit = require(resolveEngineModule(COORD_DIR, "scripts/coord-init.js"));
const createCoordConformance = require(resolveEngineModule(COORD_DIR, "scripts/coord-conformance.js"));
const createCoordUpgrade = require(resolveEngineModule(COORD_DIR, "scripts/coord-upgrade.js"));
const createReadinessDoctor = require(resolveEngineModule(COORD_DIR, "scripts/readiness-doctor.js"));
const requirementsImport = require(resolveEngineModule(COORD_DIR, "scripts/requirements-import.js"));
const requirementsLinkage = require(resolveEngineModule(COORD_DIR, "scripts/requirements-linkage.js"));
const requirementsTraceability = require(resolveEngineModule(COORD_DIR, "scripts/requirements-traceability.js"));
const requirementsScreenCoverage = require(resolveEngineModule(COORD_DIR, "scripts/requirements-screen-coverage.js"));
const requirementsPersonaWorkflow = require(resolveEngineModule(COORD_DIR, "scripts/requirements-persona-workflow.js"));
const requirementsWorkflowAlignment = require(resolveEngineModule(COORD_DIR, "scripts/requirements-workflow-alignment.js"));
const requirementsEvidencePolicy = require(resolveEngineModule(COORD_DIR, "scripts/requirements-evidence-policy.js"));
const requirementsDonorReuse = require(resolveEngineModule(COORD_DIR, "scripts/requirements-donor-reuse.js"));
const requirementsDonorDerived = require(resolveEngineModule(COORD_DIR, "scripts/requirements-donor-derived.js"));
const requirementsCommandContracts = require(resolveEngineModule(COORD_DIR, "scripts/requirements-command-contracts.js"));
const requirementsArtifactModel = require(resolveEngineModule(COORD_DIR, "scripts/requirements-artifact-model.js"));
const requirementsWalkingSkeleton = require(resolveEngineModule(COORD_DIR, "scripts/requirements-walking-skeleton.js"));
const requirementsReviewPack = require(resolveEngineModule(COORD_DIR, "scripts/requirements-review-pack.js"));
const requirementsSequencing = require(resolveEngineModule(COORD_DIR, "scripts/requirements-sequencing.js"));
const requirementsConformance = require(resolveEngineModule(COORD_DIR, "scripts/requirements-conformance.js"));
const requirementsSurfaceConformance = require(resolveEngineModule(COORD_DIR, "scripts/requirements-surface-conformance.js"));
const requirementsCockpitModel = require(resolveEngineModule(COORD_DIR, "scripts/requirements-cockpit-model.js"));
const requirementsDomainBoundary = require(resolveEngineModule(COORD_DIR, "scripts/requirements-domain-boundary.js"));
const requirementsStaleImpact = require(resolveEngineModule(COORD_DIR, "scripts/requirements-stale-impact.js"));
const requirementsGeneralizationAudit = require(resolveEngineModule(COORD_DIR, "scripts/requirements-generalization-audit.js"));
const requirementsBaselineGate = require(resolveEngineModule(COORD_DIR, "scripts/requirements-baseline-gate.js"));
const requirementsLinkageBackfill = require(resolveEngineModule(COORD_DIR, "scripts/requirements-linkage-backfill.js"));
const commandRegistry = require("./command-registry.js");
const adrValidator = require(resolveEngineModule(COORD_DIR, "scripts/adr-validator.js"));
const explorationPromotion = require(resolveEngineModule(COORD_DIR, "scripts/exploration-promotion.js"));
const businessContextPack = require(resolveEngineModule(COORD_DIR, "scripts/business-context-pack.js"));
const businessDiscovery = require(resolveEngineModule(COORD_DIR, "scripts/business-discovery.js"));
const businessDiscoverySynthesize = require(resolveEngineModule(COORD_DIR, "scripts/business-discovery-synthesize.js"));
const knowledgeClaimCompiler = require(resolveEngineModule(COORD_DIR, "scripts/knowledge-claim-compiler.js"));
const affectedTargets = require(resolveEngineModule(COORD_DIR, "scripts/affected-targets.js"));
const canonicalDerivedAuthority = require(resolveEngineModule(COORD_DIR, "scripts/canonical-derived-authority.js"));
const onboard = require(resolveEngineModule(COORD_DIR, "scripts/onboard.js"));
const trackPresets = require(resolveEngineModule(COORD_DIR, "scripts/track-presets.js"));

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
        return { code: result.code };
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

function printUsage(registry, log, options = {}) {
  log("coord — governed project CLI");
  log("");
  log("Usage: coord <command> [options]");
  log("");
  log("Commands:");
  const metadata = commandRegistry.listCommandMetadata({
    includeGovernance: false,
    includeAdvanced: options.includeAdvanced === true,
  }).filter((command) => command.maturity !== "planned_surface" && registry[command.name]);
  const names = metadata.map((command) => command.name);
  const width = names.reduce((max, n) => Math.max(max, n.length), 0);
  for (const command of metadata) {
    const maturity = command.maturity === "stable" ? "" : ` [${command.maturity}; advanced]`;
    log(`  ${command.name.padEnd(width)}  ${registry[command.name].summary}${maturity}`);
  }
  log(`  ${"help".padEnd(width)}  Show this help text.`);
  if (options.includeAdvanced === true) {
    const planned = commandRegistry.listCommandMetadata({ includeGovernance: false, includeAdvanced: true })
      .filter((command) => command.maturity === "planned_surface");
    if (planned.length) {
      log("");
      log("Planned surfaces (not runnable):");
      for (const command of planned) log(`  ${command.name}  ${command.summary}`);
    }
  }
  log("");
  log("Run `coord help --all` to discover advanced and planned surfaces.");
}

// Pure-ish dispatch: route argv to a registered command. Returns { code }.
// Never calls process.exit so it is unit-testable.
function dispatch(argv = [], deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  const registry = deps.registry || buildRegistry(deps);

  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    const unknown = rest.filter((arg) => arg !== "--all");
    if (unknown.length) {
      log(`coord help: unexpected argument ${unknown[0]}`);
      return { code: 1 };
    }
    printUsage(registry, log, { includeAdvanced: rest.includes("--all") });
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
function main() {
  const result = dispatch(process.argv.slice(2));
  process.exit(result.code);
}
if (require.main === module) main();
// COORD-873: the CLI shim at the legacy coord/scripts path re-dispatches this entry
// (same argv, same exit codes, same error handling).
module.exports.main = main;
