"use strict";

// COORD-076 (QGATE-002): dependency/security audit threshold policy.
//
// This module is the SINGLE SOURCE OF TRUTH for the audit severity-threshold
// policy that the template repo gate runners (`backend|frontend/scripts/gate.sh`)
// apply on the `full` / `ci` lanes. The bash runners shell out to a small Node
// invocation (`node coord/scripts/audit-policy.js classify`) so the
// pass/warn/fail decision is defined ONCE here rather than re-implemented in
// bash on each repo — that is what keeps the threshold from silently drifting
// between the runner and the coord-side tests/board signal.
//
// Boundary: this module is pure policy + npm-audit parsing. It does NOT run
// `npm audit` itself (the runner owns that, so it can degrade gracefully when no
// lockfile/package manager is present) and it does NOT touch the board or any
// gate artifact. gate-runtime.js owns gate EXECUTION; gates.js owns the
// board-record attribution surface; this module is the dependency-audit signal's
// policy layer that both can reference.

// Severity ladder, lowest → highest. npm audit's metadata.vulnerabilities object
// is keyed by these names (plus "total"). audit-ci uses the same vocabulary.
const SEVERITY_ORDER = Object.freeze(["info", "low", "moderate", "high", "critical"]);

// Config-driven default: the minimum severity that FAILS the audit on the
// full/ci lanes. `high` means high+critical block; moderate/low/info warn. This
// default is overridable per-repo via the GATE_AUDIT_THRESHOLD env var consumed
// by the runner (see backend/frontend scripts/gate.sh) without editing code.
const DEFAULT_AUDIT_THRESHOLD = "high";

function severityRank(severity) {
  const idx = SEVERITY_ORDER.indexOf(String(severity || "").toLowerCase());
  return idx; // -1 for unknown
}

// Normalize the per-severity counts out of an `npm audit --json` payload.
// Supports both the modern shape (metadata.vulnerabilities = {info, low,
// moderate, high, critical, total}) and a bare counts object. Returns a frozen
// object with every severity present (0-filled) and a derived `total`.
function parseAuditCounts(auditJson) {
  let raw = {};
  if (auditJson && typeof auditJson === "object") {
    if (auditJson.metadata && auditJson.metadata.vulnerabilities) {
      raw = auditJson.metadata.vulnerabilities;
    } else if (auditJson.vulnerabilities && typeof auditJson.vulnerabilities === "object" &&
               // Heuristic: a counts map has numeric values; the advisories map does not.
               SEVERITY_ORDER.some((s) => typeof auditJson.vulnerabilities[s] === "number")) {
      raw = auditJson.vulnerabilities;
    } else {
      raw = auditJson;
    }
  }
  const counts = {};
  let total = 0;
  for (const sev of SEVERITY_ORDER) {
    const n = Number.isFinite(raw[sev]) ? raw[sev] : 0;
    counts[sev] = n;
    total += n;
  }
  counts.total = Number.isFinite(raw.total) ? raw.total : total;
  return Object.freeze(counts);
}

// Classify an audit result against a severity threshold.
//   result: "fail" if any vuln at-or-above `threshold` exists;
//           "warn" if vulns exist but all below threshold;
//           "pass" if no vulns at all.
// Returns { result, threshold, counts, highestSeverity, blocking, total }.
function classifyAudit({ counts, threshold } = {}) {
  const normalized = (counts && typeof counts.total === "number")
    ? counts
    : parseAuditCounts(counts);
  const thr = SEVERITY_ORDER.includes(String(threshold || "").toLowerCase())
    ? String(threshold).toLowerCase()
    : DEFAULT_AUDIT_THRESHOLD;
  const thrRank = severityRank(thr);

  let highestSeverity = null;
  let blocking = 0;
  for (const sev of SEVERITY_ORDER) {
    const n = normalized[sev] || 0;
    if (n > 0) {
      highestSeverity = sev; // SEVERITY_ORDER ascends, so last hit is highest
      if (severityRank(sev) >= thrRank) {
        blocking += n;
      }
    }
  }

  let result;
  if ((normalized.total || 0) === 0) {
    result = "pass";
  } else if (blocking > 0) {
    result = "fail";
  } else {
    result = "warn";
  }

  return {
    result,
    threshold: thr,
    counts: normalized,
    highestSeverity,
    blocking,
    total: normalized.total || 0,
  };
}

// One-line, grep-friendly summary the runner prints and the gate signal records.
// e.g. "audit: fail threshold=high total=3 (critical=0 high=1 moderate=1 low=1 info=0) blocking=1"
function formatAuditSummary(classification) {
  const c = classification.counts;
  const parts = SEVERITY_ORDER.slice().reverse().map((s) => `${s}=${c[s] || 0}`);
  return (
    `audit: ${classification.result} threshold=${classification.threshold} ` +
    `total=${classification.total} (${parts.join(" ")}) blocking=${classification.blocking}`
  );
}

// CLI: `node audit-policy.js classify [--threshold high] < npm-audit.json`
// Reads npm-audit JSON on stdin, prints the summary, and exits non-zero on fail.
// Exit codes: 0 pass/warn, 1 fail (blocking vuln), 2 usage/parse error.
function runCli(argv, { stdin, stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const sub = argv[0];
  if (sub !== "classify") {
    err.write(`usage: audit-policy.js classify [--threshold <sev>]\n`);
    return 2;
  }
  let threshold = DEFAULT_AUDIT_THRESHOLD;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--threshold" && argv[i + 1]) {
      threshold = argv[i + 1];
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
  let auditJson = null;
  try {
    auditJson = payload && payload.trim() ? JSON.parse(payload) : {};
  } catch {
    err.write(`audit: ERROR could not parse npm audit JSON\n`);
    return 2;
  }
  const counts = parseAuditCounts(auditJson);
  const classification = classifyAudit({ counts, threshold });
  out.write(formatAuditSummary(classification) + "\n");
  return classification.result === "fail" ? 1 : 0;
}

module.exports = {
  SEVERITY_ORDER,
  DEFAULT_AUDIT_THRESHOLD,
  severityRank,
  parseAuditCounts,
  classifyAudit,
  formatAuditSummary,
  runCli,
};

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2), {});
}
