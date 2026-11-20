"use strict";

// COORD-077 (QGATE-003): test-coverage threshold policy.
//
// This module is the SINGLE SOURCE OF TRUTH for the coverage-threshold policy
// that the template repo gate runners (`backend|frontend/scripts/gate.sh`) apply
// on the `full` / `ci` lanes. It mirrors audit-policy.js (COORD-076): the bash
// runners shell out to a small Node invocation
// (`node coord/engine/scripts/coverage-policy.js classify`) so the pass/warn/fail
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
// Leading "ℹ " info markers, Node 22 TAP comment markers ("# "), and
// surrounding whitespace are tolerated. Returns { lines, branches, functions }
// as numbers (or nulls if a column is absent), or null when no summary row is
// present (no coverage emitted).
function parseCoverageReport(text) {
  if (!text || typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  // Prefer the canonical "all files" aggregate row; fall back to none.
  for (const raw of lines) {
    const stripped = raw.replace(/^\s*(?:ℹ|#)\s?/, "").trim();
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

// COORD-705: read the test-count summary line the Node test runner emits
// ("ℹ tests 12" on the spec reporter, "# tests 12" on the TAP reporter Node 22
// defaults to when stdout is not a TTY). This is the discriminator the coverage
// contract was missing: it separates "there was nothing to measure" (a minimal
// skeleton with zero tests — legitimately green) from "tests ran and the
// coverage data still did not arrive" (a measurement that was EXPECTED and is
// absent — which must never satisfy a threshold). Returns the integer total, or
// null when the report carries no test-count line at all, which is itself
// evidence that the nested test run never completed.
function parseTestTotal(text) {
  if (!text || typeof text !== "string") return null;
  for (const raw of text.split(/\r?\n/)) {
    const stripped = raw.replace(/^\s*(?:ℹ|#)\s?/, "").trim();
    const m = /^tests\s+(\d+)\s*$/.exec(stripped);
    if (m) return Number(m[1]);
  }
  return null;
}

// Classify a parsed coverage summary against a minimum-% threshold.
//
// COORD-705: the absence of measurement must NOT satisfy a threshold. Before
// this ticket every "no coverage data" outcome collapsed into a single green
// "warn", so a skeleton with genuinely nothing to measure and a repository whose
// coverage run silently produced nothing were the SAME result — and an
// impossible minimum such as min=101 could still be reported PASS, which is
// proof the threshold was never evaluated against data. The vocabulary is now:
//
//   "pass"    every tracked metric >= threshold (measured).
//   "warn"    measured but under threshold within the warn band, OR nothing was
//             expected to be measured (see reason below) — green, never fails.
//   "fail"    measured and below (threshold - warnBand).
//   "missing" measurement was EXPECTED and did not arrive — NON-PASSING. This is
//             the outcome the graceful-skip path used to swallow.
//
// The discriminator is `testsTotal` (parseTestTotal above):
//   testsTotal === 0    → nothing to measure. Green, reason "no-tests". This
//                         also covers the vacuous report Node emits for an empty
//                         suite (every metric 100%): a repo with zero tests must
//                         not be able to CLEAR a minimum it never measured. A
//                         genuine "fail" is never masked (never weaken, (e)).
//   testsTotal  >  0    → tests ran, so coverage was expected: absent data is
//                         "missing", reason "measurement-expected-but-absent".
//   testsTotal === null → the report carries no test-count line at all (the
//                         nested run never completed). "missing" when the caller
//                         signalled `expectMeasurement` (gate.sh does whenever
//                         GATE_COVERAGE_MIN is explicitly set); otherwise the
//                         historical green "warn", reason "no-coverage-data".
//
// Returns { result, threshold, warnBand, metrics, lowest, available, measured,
//           testsTotal, reason }.
function classifyCoverage({ metrics, threshold, warnBand, testsTotal, expectMeasurement } = {}) {
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

  const tests = Number.isInteger(testsTotal) && testsTotal >= 0 ? testsTotal : null;

  let result;
  let reason = null;
  if (available) {
    if (lowest < thr - band) {
      result = "fail";
    } else if (lowest < thr) {
      result = "warn";
    } else {
      result = "pass";
    }
    if (tests === 0) {
      // A zero-test suite still emits a (vacuous) 100% report. Clearing a
      // minimum on it would be the same false green this ticket exists to
      // remove, so it is never reported as measured, and a "pass" is downgraded
      // to the named green skip — but a real "fail" is NEVER upgraded into it
      // ((e): no threshold is weakened by this change).
      reason = "no-tests";
      if (result !== "fail") result = "warn";
    }
  } else if (tests === 0) {
    result = "warn"; // nothing to measure — the graceful contract, preserved
    reason = "no-tests";
  } else if (tests > 0 || expectMeasurement === true) {
    // The false green this ticket removes: data was expected and never arrived.
    result = "missing";
    reason = "measurement-expected-but-absent";
  } else {
    result = "warn";
    reason = "no-coverage-data";
  }

  return {
    result,
    threshold: thr,
    warnBand: band,
    metrics: values,
    lowest,
    available,
    // `measured` is the single boolean a consumer needs to tell
    // measured-and-met from never-measured. It is false for BOTH green
    // no-measurement outcomes and for "missing".
    measured: available && tests !== 0,
    testsTotal: tests,
    reason,
  };
}

// Results that must not be reported as a passing coverage step.
const NON_PASSING_RESULTS = Object.freeze(["fail", "missing"]);

function isNonPassing(result) {
  return NON_PASSING_RESULTS.includes(result);
}

// One-line, grep-friendly summary the runner prints and the gate signal records.
// e.g. "coverage: pass min=80 (lines=92.31 branches=85.00 functions=100.00) lowest=85.00 measured=yes tests=12"
// When no data: "coverage: warn min=80 (no coverage data) lowest=n/a measured=no tests=0 reason=no-tests"
// COORD-705: the trailing `measured=`/`tests=`/`reason=` fields are what make
// measured-and-met textually distinguishable from never-measured on stdout. The
// leading `coverage: <result> min=<n> (<body>) lowest=<n>` prefix is unchanged so
// existing consumers/greps keep working.
function formatCoverageSummary(classification) {
  const m = classification.metrics || {};
  const fmt = (v) => (v == null ? "n/a" : v.toFixed(2));
  const body = classification.available
    ? `(${METRICS.map((k) => `${k}=${fmt(m[k])}`).join(" ")})`
    : "(no coverage data)";
  const lowest = classification.lowest == null ? "n/a" : classification.lowest.toFixed(2);
  const measured = classification.measured ? "yes" : "no";
  const tests = classification.testsTotal == null ? "unknown" : String(classification.testsTotal);
  const reason = classification.reason ? ` reason=${classification.reason}` : "";
  return (
    `coverage: ${classification.result} min=${classification.threshold} ${body} ` +
    `lowest=${lowest} measured=${measured} tests=${tests}${reason}`
  );
}

// CLI: `node coverage-policy.js classify [--min 80] [--warn-band 0]
//        [--expect-coverage] < coverage-report.txt`
// Reads the Node test-coverage textual report on stdin, prints the summary, and
// exits non-zero on any NON-PASSING result.
// Exit codes: 0 pass/warn, 1 fail (below min) or missing (COORD-705: coverage
// was expected and absent), 2 usage error.
// `--expect-coverage` tells the policy the caller EXPECTED measurement even when
// the report is so empty it does not carry a test-count line (gate.sh passes it
// whenever GATE_COVERAGE_MIN was explicitly set).
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
  let expectCoverage = false;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--min" && argv[i + 1] != null) {
      threshold = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--warn-band" && argv[i + 1] != null) {
      warnBand = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--expect-coverage") {
      expectCoverage = true;
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
  const classification = classifyCoverage({
    metrics: metrics || {},
    threshold,
    warnBand,
    testsTotal: parseTestTotal(payload),
    expectMeasurement: expectCoverage,
  });
  out.write(formatCoverageSummary(classification) + "\n");
  return isNonPassing(classification.result) ? 1 : 0;
}

module.exports = {
  METRICS,
  DEFAULT_COVERAGE_MIN,
  COVERAGE_WARN_BAND,
  NON_PASSING_RESULTS,
  isNonPassing,
  parseCoverageReport,
  parseTestTotal,
  classifyCoverage,
  formatCoverageSummary,
  runCli,
};

function main() {
  // COORD-876: a leading --help prints the usage on stdout and exits 0.
  if (process.argv[2] === "--help") { runCli([], { stderr: process.stdout }); process.exitCode = 0; return; }
  process.exitCode = runCli(process.argv.slice(2), {});
}
if (require.main === module) main();
module.exports.main = main;
