#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createCoordPaths } = require("../paths.js");

// COORD-071: the expected baseline map is now DERIVED from the config seam
// (coord/project.config.js) rather than hardcoded here. `repo` comes from each
// repo's configured directory (repoRegistry) and `command` from its per-repo
// `testCommand`. Downstream projects configure these in project.config.js
// instead of editing this engine file. The `options.expectedBaseline` override
// hook is preserved for tests and bespoke callers.
//
// Repos without a configured `testCommand` are skipped (no baseline contract
// to enforce until the project declares one).
function deriveExpectedBaseline(paths) {
  const expected = {};
  const repoRegistry = (paths && paths.repoRegistry) || {};
  const repoTestCommands = (paths && paths.repoTestCommands) || {};
  for (const [code, repoDir] of Object.entries(repoRegistry)) {
    const command = repoTestCommands[code];
    if (!command) {
      continue;
    }
    const normalizedDir = String(repoDir)
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    if (!normalizedDir) {
      continue;
    }
    expected[code] = { repo: `${normalizedDir}/`, command };
  }
  return expected;
}

function readPackageScripts(repoRoot) {
  const packagePath = path.join(repoRoot, "package.json");
  const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return parsed.scripts || {};
}

function validateTestingBaseline(options = {}) {
  const coordDir = options.coordDir || path.resolve(__dirname, "..");
  const rootDir = options.rootDir || path.dirname(coordDir);
  const baselinePath =
    options.baselinePath || path.join(coordDir, "product", "TESTING_BASELINE.md");
  const paths = createCoordPaths({ coordDir, rootDir });
  const expected = options.expectedBaseline || deriveExpectedBaseline(paths);
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(baselinePath)) {
    errors.push(
      `testing baseline not found at ${baselinePath}; create it (see coord/scripts/check-testing-baseline.js for the expected table format) so the coverage-floor contract can be enforced`,
    );
    return { ok: false, errors, warnings };
  }
  const content = fs.readFileSync(baselinePath, "utf8");

  for (const [code, spec] of Object.entries(expected)) {
    if (!content.includes(`| \`${spec.repo}\``)) {
      errors.push(`TESTING_BASELINE.md is missing repo row for ${spec.repo}`);
    }
    if (!content.includes(`\`${spec.command}\``)) {
      errors.push(`TESTING_BASELINE.md is missing baseline command ${spec.command}`);
    }
    const rowPattern = new RegExp(
      `\\|\\s+\`${spec.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`\\s+\\|\\s+\`([^\`]+)\``,
    );
    const row = content.match(rowPattern);
    if (row && /--forceExit/.test(row[1])) {
      errors.push(`${spec.repo} canonical baseline command must not use --forceExit`);
    }

    const repoRoot = paths.repoRoots[code];
    if (repoRoot && fs.existsSync(path.join(repoRoot, "package.json"))) {
      const scripts = readPackageScripts(repoRoot);
      for (const [name, command] of Object.entries(scripts)) {
        if (/^test:ci/.test(name) && /--forceExit/.test(String(command))) {
          errors.push(`${spec.repo} ${name} uses --forceExit`);
        }
      }
      const [runner, scriptName] = spec.command.split(/\s+run\s+|\s+/).slice(-2);
      if (!scripts[scriptName]) {
        warnings.push(`${spec.repo} has not implemented ${spec.command} yet`);
      }
      void runner;
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

function main() {
  const result = validateTestingBaseline();
  for (const warning of result.warnings) {
    console.error(`warning: ${warning}`);
  }
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`error: ${error}`);
    }
    process.exit(1);
  }
  console.log("Testing baseline contract OK");
}

if (require.main === module) {
  main();
}

module.exports = {
  deriveExpectedBaseline,
  validateTestingBaseline,
};
