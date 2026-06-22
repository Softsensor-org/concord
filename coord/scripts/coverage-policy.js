"use strict";

// COORD-077 (QGATE-003): test-coverage threshold policy.
//
// This module is the SINGLE SOURCE OF TRUTH for the coverage-threshold policy
// that the template repo gate runners (`backend|frontend/scripts/gate.sh`) apply
// on the `full` / `ci` lanes. It mirrors audit-policy.js (COORD-076): the bash
// runners shell out to a small Node invocation
// (`node coord/scripts/coverage-policy.js classify`) so the pass/warn/fail
// decision is defined ONCE here rather than re-implemented in bash on each repo
// — that is what keeps the threshold from silently drifting between the runner
// and the coord-side tests/board signal.
//
// Boundary: this module is pure policy + Node `--experimental-test-coverage`
// report parsing. It does NOT run the tests itself (the runner owns that, so it
// can degrade gracefully when there are no tests / no coverage tooling) and it
// does NOT touch the board or any gate artifact. gate-runtime.js owns gate
// EXECUTION; gates.js owns the board-record attribution surface; this module is
// the coverage signal's policy layer that both can reference.

// The three coverage metrics Node's built-in test coverage reports, in the
// column order of its summary table ("all files | line % | branch % | funcs %").
const METRICS = Object.freeze(["lines", "branches", "functions"]);

// Config-driven default: the minimum line/branch/function coverage percentage
// that must be met on the full/ci lanes. A conservative default that minimal
// template skeletons can clear; per-repo overridable via the GATE_COVERAGE_MIN
// env var consumed by the runner (see backend/frontend scripts/gate.sh) without
// editing code. Below this => fail; tooling/output missing => warn (skip).
const DEFAULT_COVERAGE_MIN = 80;

// A small grace band below the hard minimum: coverage in [min - WARN_BAND, min)
// warns instead of failing, so a repo that drifts slightly under target gets a
// loud signal before the gate turns red. Set to 0 to make the threshold a hard
// cliff.
const COVERAGE_WARN_BAND = 0;

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

// Parse Node's `--experimental-test-coverage` textual report. We read the
// "all files" summary row, whose pipe-separated columns are:
//   all files | <line %> | <branch %> | <funcs %> | <uncovered lines>
// Leading "ℹ " info markers and surrounding whitespace are tolerated. Returns
// { lines, branches, functions } as numbers (or nulls if a column is absent),
// or null when no summary row is present (no coverage emitted).
function parseCoverageReport(text) {
  if (!text || typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  // Prefer the canonical "all files" aggregate row; fall back to none.
  for (const raw of lines) {
    const stripped = raw.replace(/^\s*[ℹℹ]\s?/, "").trim();
    if (!/^all files\b/i.test(stripped)) continue;
    const cols = stripped.split("|").map((c) => c.trim());
    // cols[0] = "all files", cols[1..3] = line/branch/funcs %.
    return {
      lines: clampPct(cols[1]),
      branches: clampPct(cols[2]),
      functions: clampPct(cols[3]),
    };
  }
  return null;
}

// Classify a parsed coverage summary against a minimum-% threshold.
//   result: "warn" when no coverage data is available (graceful skip);
//           "fail" when any tracked metric is below (threshold - warnBand);
//           "warn" when any tracked metric is below threshold but within band;
//           "pass" when every tracked metric is >= threshold.
// Returns { result, threshold, warnBand, metrics, lowest, available }.
function classifyCoverage({ metrics, threshold, warnBand } = {}) {
  const thr = Number.isFinite(Number(threshold)) ? Number(threshold) : DEFAULT_COVERAGE_MIN;
  const band = Number.isFinite(Number(warnBand)) ? Number(warnBand) : COVERAGE_WARN_BAND;

  const parsed = (metrics && typeof metrics === "object" && !Array.isArray(metrics)) ? metrics : {};
  const values = {};
  let available = false;
  let lowest = null;
  for (const m of METRICS) {
    const v = clampPct(parsed[m]);
    values[m] = v;
    if (v != null) {
      available = true;
      if (lowest == null || v < lowest) lowest = v;
    }
  }

  let result;
  if (!available) {
    result = "warn"; // no coverage data — graceful skip, never fail
  } else if (lowest < thr - band) {
    result = "fail";
  } else if (lowest < thr) {
    result = "warn";
  } else {
    result = "pass";
  }

  return {
    result,
    threshold: thr,
    warnBand: band,
    metrics: values,
    lowest,
    available,
  };
}

// One-line, grep-friendly summary the runner prints and the gate signal records.
// e.g. "coverage: pass min=80 (lines=92.31 branches=85.00 functions=100.00) lowest=85.00"
// When no data: "coverage: warn min=80 (no coverage data) lowest=n/a"
function formatCoverageSummary(classification) {
  const m = classification.metrics || {};
  const fmt = (v) => (v == null ? "n/a" : v.toFixed(2));
  const body = classification.available
    ? `(${METRICS.map((k) => `${k}=${fmt(m[k])}`).join(" ")})`
    : "(no coverage data)";
  const lowest = classification.lowest == null ? "n/a" : classification.lowest.toFixed(2);
  return `coverage: ${classification.result} min=${classification.threshold} ${body} lowest=${lowest}`;
}

// CLI: `node coverage-policy.js classify [--min 80] [--warn-band 0] < coverage-report.txt`
// Reads the Node test-coverage textual report on stdin, prints the summary, and
// exits non-zero only on a hard fail (below threshold with coverage present).
// Exit codes: 0 pass/warn/skip, 1 fail (below min), 2 usage error.
function runCli(argv, { stdin, stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const sub = argv[0];
  if (sub !== "classify") {
    err.write(`usage: coverage-policy.js classify [--min <pct>] [--warn-band <pct>]\n`);
    return 2;
  }
  let threshold = DEFAULT_COVERAGE_MIN;
  let warnBand = COVERAGE_WARN_BAND;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--min" && argv[i + 1] != null) {
      threshold = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--warn-band" && argv[i + 1] != null) {
      warnBand = argv[i + 1];
      i += 1;
    }
  }
  let payload = stdin;
  if (payload == null) {
    try {
      payload = require("fs").readFileSync(0, "utf8");
    } catch {
      payload = "";
    }
  }
  const metrics = parseCoverageReport(payload);
  const classification = classifyCoverage({ metrics: metrics || {}, threshold, warnBand });
  out.write(formatCoverageSummary(classification) + "\n");
  return classification.result === "fail" ? 1 : 0;
}

module.exports = {
  METRICS,
  DEFAULT_COVERAGE_MIN,
  COVERAGE_WARN_BAND,
  parseCoverageReport,
  classifyCoverage,
  formatCoverageSummary,
  runCli,
};

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2), {});
}
