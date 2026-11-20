#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function parseArgs(argv) {
  const options = { repoDir: process.cwd(), threshold: process.env.GATE_AUDIT_THRESHOLD || "high" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo-dir") options.repoDir = path.resolve(argv[++i]);
    else if (argv[i] === "--threshold") options.threshold = argv[++i];
    else if (argv[i] === "--audit-policy") options.auditPolicy = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

function emit(result, exitCode) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return exitCode;
}

function run(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return emit({ command: "npm --prefix apps/coord-ui audit --json", status: "unavailable", reason: error.message }, 2);
  }

  const command = "npm --prefix apps/coord-ui audit --json";
  const lockPath = path.join(options.repoDir, "apps/coord-ui/package-lock.json");
  if (!fs.existsSync(lockPath)) {
    return emit({ command, status: "skipped", summary: "coord-ui audit skipped: nested lockfile absent", reason: "missing lockfile" }, 0);
  }
  if (process.env.GATE_AUDIT_OFFLINE === "1") {
    return emit({ command, status: "unavailable", reason: "offline advisory data is not validated; refusing a clean result" }, 2);
  }

  const npm = spawnSync("npm", ["--prefix", "apps/coord-ui", "audit", "--json"], {
    cwd: options.repoDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (npm.error || npm.signal || npm.status === null) {
    return emit({ command, status: "unavailable", reason: npm.error ? npm.error.message : `npm terminated by ${npm.signal || "unknown signal"}` }, 2);
  }

  let report;
  try {
    report = JSON.parse(npm.stdout || "");
  } catch {
    return emit({ command, status: "unavailable", npmExitCode: npm.status, reason: npm.stdout ? "npm returned malformed JSON" : "npm returned empty output" }, 2);
  }
  const counts = report?.metadata?.vulnerabilities;
  const countKeys = ["info", "low", "moderate", "high", "critical", "total"];
  const validCounts = counts && countKeys.every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0) &&
    counts.total === counts.info + counts.low + counts.moderate + counts.high + counts.critical;
  const validVulnerabilityMap = report?.vulnerabilities && typeof report.vulnerabilities === "object" && !Array.isArray(report.vulnerabilities);
  if (report?.error || !validCounts || !validVulnerabilityMap) {
    return emit({ command, status: "unavailable", npmExitCode: npm.status, reason: "npm JSON lacks complete consistent advisory counts, a vulnerability map, or contains an error" }, 2);
  }
  if (npm.status !== 0 && npm.status !== 1) {
    return emit({ command, status: "unavailable", npmExitCode: npm.status, reason: "npm exited with a non-advisory error status" }, 2);
  }

  let policy;
  try {
    policy = require(options.auditPolicy || path.resolve(options.repoDir, "../coord/engine/scripts/audit-policy.js"));
  } catch (error) {
    return emit({ command, status: "unavailable", npmExitCode: npm.status, reason: `audit policy unavailable: ${error.message}` }, 2);
  }
  const classification = policy.classifyAudit({ counts: policy.parseAuditCounts(report), threshold: options.threshold });
  if (npm.status === 1 && classification.total === 0) {
    return emit({ command, status: "unavailable", npmExitCode: npm.status, reason: "npm reported failure but JSON contains no advisories" }, 2);
  }
  return emit({
    command,
    status: classification.result,
    npmExitCode: npm.status,
    summary: `coord-ui ${policy.formatAuditSummary(classification)}`,
  }, classification.result === "fail" ? 1 : 0);
}

if (require.main === module) process.exitCode = run();
module.exports = { run };
