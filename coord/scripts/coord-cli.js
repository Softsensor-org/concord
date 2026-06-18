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

// Build the command registry. Factored so tests can build a registry with
// injected deps (fs/log/cwd) and assert routing without touching the real repo.
function buildRegistry(deps = {}) {
  const init = createCoordInit(deps);
  const conformance = createCoordConformance(deps);
  const upgrade = createCoordUpgrade(deps);
  return {
    init: {
      summary: "Bootstrap a repo into a governed-board layout (idempotent, no-clobber).",
      run: (args) => {
        const result = init.run(args);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    conformance: {
      summary: "Verify engine conformance (journal chain self-verify; --attest/--verify signed attestation).",
      run: (args) => {
        const result = conformance.run(args);
        return { code: result.code != null ? result.code : 0 };
      },
    },
    upgrade: {
      summary: "Apply a new engine version (--from <dir|bundle>) into a repo, re-pin + verify; rollback on failure.",
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
