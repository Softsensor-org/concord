#!/usr/bin/env node
"use strict";

// COORD-082 (CONTRACT-002): frontend contract entrypoint.
//
// `npm run contract:gen`   — regenerate the committed API client from the
//                            backend's OpenAPI artifact.
// `npm run contract:check` — regenerate into memory and DIFF against the
//                            committed client; exit non-zero (fail the gate) if
//                            the committed client is STALE.
//
// CI-safe + path-independent by design: the OpenAPI SOURCE path is NOT hardcoded
// to a sibling (the anti-pattern that broke downstream CI — `../api/openapi.json`).
// It is resolved through coord's config seam (coord/project.config.js
// `repos.F.contract`) + repo-registry path resolution (paths.js `repoRoots`),
// implemented once in coord/scripts/contract-policy.js. This thin shim only
// locates that policy and forwards the subcommand, degrading gracefully (skip,
// never crash) when coord is not vendored alongside this repo.

const path = require("path");
const fs = require("fs");

const sub = process.argv[2];
if (sub !== "gen" && sub !== "check") {
  process.stderr.write("usage: node scripts/contract.js <gen|check>\n");
  process.exit(2);
}

// Locate the coord policy relative to this repo (sibling `coord/` dir, the
// template/default layout). A generated repo with a different coord location can
// override via COORD_DIR.
const repoDir = path.resolve(__dirname, "..");
const coordDir = process.env.COORD_DIR
  ? path.resolve(process.env.COORD_DIR)
  : path.resolve(repoDir, "..", "coord");
const policyPath = path.join(coordDir, "scripts", "contract-policy.js");

if (!fs.existsSync(policyPath)) {
  // Graceful skip: no coord policy vendored -> nothing to gen/check.
  process.stdout.write(
    `contract: skip (coord contract-policy not found at ${policyPath}; set COORD_DIR if coord lives elsewhere)\n`,
  );
  process.exit(0);
}

// Resolve THIS repo's code from coord's config so the policy targets the right
// contract block regardless of directory name. Falls back to letting the policy
// auto-pick the sole repo that declares a contract block.
const { createCoordPaths } = require(path.join(coordDir, "paths.js"));
const { runCli } = require(policyPath);
const paths = createCoordPaths({ coordDir });

let repoCode = null;
for (const [code, entry] of Object.entries((paths.projectConfig || {}).repos || {})) {
  if (
    paths.repoRoots[code] &&
    path.resolve(paths.repoRoots[code]) === repoDir &&
    entry &&
    entry.contract
  ) {
    repoCode = code;
    break;
  }
}

const argv = [sub];
if (repoCode) argv.push("--repo", repoCode);
process.exit(runCli(argv, { paths }));
