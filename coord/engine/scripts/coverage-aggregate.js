"use strict";

// COORD-786: launch the measured worker in an isolated process with raw coverage
// disabled. The worker's actual implementation lives in coverage-aggregate-worker.js.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const workerPath = path.join(__dirname, "coverage-aggregate-worker.js");

const GIB = 1024n ** 3n;

function filesystemFor(directory) {
  let existing = path.resolve(directory);
  for (;;) {
    try {
      return fs.statfsSync(existing, { bigint: true });
    } catch (error) {
      const parent = path.dirname(existing);
      if (error.code !== "ENOENT" || parent === existing) throw error;
      existing = parent;
    }
  }
}

function coverageSpaceError(directories, { sharded = false } = {}) {
  const minimum = process.env.COORD_COVERAGE_MIN_FREE_GIB ?? (sharded ? "32" : "8");
  if (!/^[1-9][0-9]*$/.test(minimum)) {
    return "COORD_COVERAGE_MIN_FREE_GIB must be a positive integer";
  }
  for (const directory of new Set(directories)) {
    try {
      const { bsize, bavail } = filesystemFor(directory);
      const available = bsize * bavail;
      if (available < BigInt(minimum) * GIB) {
        return `insufficient free disk space for coverage at ${path.resolve(directory)}: ` +
          `${(Number(available) / Number(GIB)).toFixed(1)} GiB available, ${minimum} GiB required ` +
          "(COORD_COVERAGE_MIN_FREE_GIB)";
      }
    } catch (error) {
      return `cannot check free disk space for coverage at ${path.resolve(directory)}: ${error.message}`;
    }
  }
  return null;
}

function admitCoverageRun({ reportPath, censusOutput, sharded }, err) {
  const destinations = [os.tmpdir(), path.dirname(path.resolve(reportPath)), process.env.RUNNER_TEMP, censusOutput].filter(Boolean);
  const problem = coverageSpaceError(destinations, { sharded });
  if (!problem) return true;
  err.write(`test-runner: ${problem}\n`);
  return false;
}

function aggregateRawCoverage(modules, cwd, witnessFiles) {
  if (!Array.isArray(witnessFiles)) throw new Error("native coverage aggregation requires an explicit production witness-file census");
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_OPTIONS;
  const child = spawnSync(process.execPath, ["--expose-internals", workerPath, path.resolve(cwd)], {
    cwd, input: JSON.stringify({ modules, witnessFiles }), encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error || child.status !== 0) {
    const detail = child.stderr || child.stdout || child.error?.message || `exit status ${child.status}`;
    throw new Error(detail.trim());
  }
  try { return JSON.parse(child.stdout); }
  catch (error) { throw new Error(`native coverage aggregation returned invalid evidence: ${error.message}`); }
}

module.exports = { aggregateRawCoverage, coverageSpaceError, admitCoverageRun };
