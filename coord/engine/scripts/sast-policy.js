"use strict";

// COORD-132 (Quality dimension #2: SAST — security-focused static analysis).
// The SECOND EXTERNAL-tool-adapter dimension built per the dimension contract in
// coord/engine/docs/QUALITY_DIMENSIONS.md (§2.3(b)/§3), mirroring COORD-131's
// mutation-policy.js. The gap it closes: the native arch-checks dimensions catch
// structural debt/drift, and `npm audit` catches dependency CVEs, but nothing
// performs SECURITY-focused static analysis of the SOURCE (injection / taint /
// unsafe-API patterns). This adapter wraps Semgrep (primary; CodeQL is a later
// option) and turns its SARIF/JSON output into the uniform finding shape, then
// applies the COORD-126 ratchet so a repo with legacy security debt can opt in
// without going red — only NEWLY-introduced findings block.
//
// This module is the SINGLE SOURCE OF TRUTH for the SAST policy, the same way
// audit-policy.js / coverage-policy.js / mutation-policy.js are for theirs. It is:
//   1. an ADAPTER  — run Semgrep (BOUNDED, own process group), parse its SARIF
//                     (or legacy JSON `results`) into the uniform finding shape
//                     (one finding per result);
//   2. a VERDICT    — RATCHET DEFAULT (fail only on NEW findings vs a base ref),
//                     reusing COORD-126 classifyFindingsAgainstBaseline /
//                     summarizeRatchet from arch-checks.js — NOT re-implemented
//                     here; an optional `threshold` severity mode is also offered.
//   3. EVIDENCE     — a one-line summary + a `sast` field for the gate artifact
//                     (gate-artifact-schema.js), with a skip-reason when the tool
//                     is unavailable.
//
// THE OPTIONALITY CONSTRAINT IS PARAMOUNT (same as COORD-131). The engine has
// ZERO runtime deps and adopters MAY NOT have Semgrep installed. So Semgrep is
// NOT in any package.json and is NOT bundled. The adapter DETECTS whether the
// tool is available + configured and, when absent, SKIPS GRACEFULLY (result
// "skip", never "fail"). A missing tool must NEVER fail the gate, and the
// dimension is OPT-IN: it only RUNS when a repo explicitly enables it
// (GATE_SAST_ENABLED=1 in gate.sh) AND the Semgrep binary resolves. Default =
// skipped, so the existing gate is unperturbed.
//
// Boundary: this module is pure policy + Semgrep-output parsing + a bounded
// runner. It does NOT touch the board or the gate-artifact write (gate.sh owns
// that). It mirrors the other policy modules: single-source the policy ONCE in
// Node rather than re-typing it in bash on every repo.

const { resolveBin, selectTool, parseClassifyArgv } = require("./external-tool-adapter.js");
const fs = require("fs");
const path = require("path");
const { runBoundedProcessGroup } = require("./bounded-process-runner.js");
const {
  classifyFindingsAgainstBaseline,
  summarizeRatchet,
} = require("./arch-checks.js");

// Default bound for the heavy Semgrep step (ms). Static analysis over a large
// tree can be slow; this is generous but finite so a hung run can never block the
// gate. The COORD-129 process-group SIGKILL enforces it. Overridable via
// GATE_SAST_TIMEOUT_MS.
const DEFAULT_SAST_TIMEOUT_MS = 10 * 60 * 1000;

// Default severity floor for the optional `threshold` mode: any finding at or
// above this severity fails. RATCHET is the default verdict (see classifySast);
// threshold is offered for repos that want an absolute severity bar instead.
const DEFAULT_SAST_THRESHOLD = "error";

// Semgrep severities, ranked. Semgrep emits ERROR / WARNING / INFO (its native
// JSON) and SARIF maps these onto level error / warning / note. We rank them so
// the threshold mode and the fail/warn severity mapping are single-sourced.
const SEVERITY_RANK = Object.freeze({ info: 1, note: 1, warning: 2, warn: 2, error: 3 });

function severityRank(sev) {
  return SEVERITY_RANK[String(sev || "").toLowerCase()] || 0;
}

// ---------------------------------------------------------------------------
// 1. DETECTION — is the dimension's tool available?
// ---------------------------------------------------------------------------
// The dimension is OPT-IN (gate.sh gates it behind GATE_SAST_ENABLED=1). It is
// "available" when the Semgrep binary resolves. Unlike Stryker (which is a
// node_modules-local dev dependency), Semgrep is typically a SYSTEM binary
// (pip/brew/CI image), so we resolve it from PATH (SEMGREP_BIN override) AND the
// repo-local node_modules/.bin (some adopters wrap it). When it does not resolve
// we skip gracefully. This is detection-only (no execution), safe + instant on
// every repo, including the zero-dependency template stub.
function resolveSemgrepBin(repoRoot, deps = {}) {
  return resolveBin(SEMGREP_TOOL, repoRoot, deps);
}

// Resolve a binary name against PATH without spawning anything. Pure fs.
const SEMGREP_TOOL = Object.freeze({ name: "semgrep", bin: "semgrep", overrideKey: "SEMGREP_BIN" });
const SAST_TOOL_TABLE = Object.freeze({
  tools: Object.freeze([SEMGREP_TOOL]),
  unavailable: "Semgrep not installed (no semgrep on PATH / SEMGREP_BIN / node_modules/.bin) — SAST dimension unavailable",
});

// Argv spec for the shared classify shell (COORD-986): flag -> option key.
const CLASSIFY_CLI = Object.freeze({
  label: "sast",
  usage:
  "usage: sast-policy.js classify --root <repo> [--mode ratchet|threshold] " +
  "[--threshold <sev>] [--timeout-ms <n>] [--config <auto|path>] [--base-report <path>]\n",
  defaultMode: "ratchet",
  flags: Object.freeze({
    "--root": Object.freeze({ key: "repoRoot" }),
    "--mode": Object.freeze({ key: "mode" }),
    "--threshold": Object.freeze({ key: "threshold" }),
    "--timeout-ms": Object.freeze({ key: "timeoutMs", number: true }),
    "--config": Object.freeze({ key: "configArg" }),
    "--base-report": Object.freeze({ key: "baseReportPath" }),
  }),
});

// Detect tool presence. Returns { available, bin, reason }.
// `available` is true only when the Semgrep binary resolves. `reason` explains a
// skip (binary absent) for the artifact.
function detectTool(repoRoot, deps = {}) {
  const d = selectTool(SAST_TOOL_TABLE, repoRoot, deps);
  return d.available ? { available: true, bin: d.bin, reason: null } : { available: false, bin: null, reason: d.reason };
}

// ---------------------------------------------------------------------------
// 2. NORMALIZE + PARSE — Semgrep SARIF (or legacy JSON `results`) -> findings[].
// ---------------------------------------------------------------------------
// Message normalization for the stable key. Semgrep messages often embed
// volatile, line/instance-specific detail (the exact tainted variable, a column,
// a snippet). For the stable key we want identity to track THE RULE FIRING AT A
// FILE, not the churny per-instance text. So we normalize: lowercase, collapse
// whitespace, strip line/column-ish numbers and quoted snippets, and trim. Two
// firings of the same rule in the same file whose message differs only in such
// volatile detail collapse to the SAME normalized message => the SAME key.
function normalizeMessage(message) {
  return String(message == null ? "" : message)
    .toLowerCase()
    // strip quoted code snippets / identifiers that vary per instance
    .replace(/[`'"][^`'"]*[`'"]/g, "")
    // strip "line N" / "col N" / ":N:N" position detail
    .replace(/\b(line|col|column)\s*\d+/g, "")
    .replace(/:\d+(:\d+)?/g, "")
    // strip any remaining bare numbers (offsets, counts)
    .replace(/\b\d+\b/g, "")
    // collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

// Pull the rule id from a SARIF result (ruleId, or rule.id) or legacy
// `check_id`. Returns a string (possibly "" when none present).
function ruleIdOf(result) {
  if (!result || typeof result !== "object") return "";
  if (result.ruleId) return String(result.ruleId);
  if (result.rule && result.rule.id) return String(result.rule.id);
  if (result.check_id) return String(result.check_id); // legacy semgrep json
  return "";
}

// Pull the message text from a SARIF result (message.text) or legacy
// (extra.message). Returns a string.
function messageOf(result) {
  if (!result || typeof result !== "object") return "";
  if (result.message && typeof result.message === "object" && result.message.text) {
    return String(result.message.text);
  }
  if (typeof result.message === "string") return result.message;
  if (result.extra && result.extra.message) return String(result.extra.message); // legacy
  return "";
}

// Pull the file path from a SARIF result
// (locations[0].physicalLocation.artifactLocation.uri) or legacy (path).
function fileOf(result) {
  if (!result || typeof result !== "object") return "";
  const loc = Array.isArray(result.locations) ? result.locations[0] : null;
  const uri =
    loc &&
    loc.physicalLocation &&
    loc.physicalLocation.artifactLocation &&
    loc.physicalLocation.artifactLocation.uri;
  if (uri) return String(uri);
  if (result.path) return String(result.path); // legacy semgrep json
  return "";
}

// Pull the 1-based start line (locations[0].physicalLocation.region.startLine)
// or legacy (start.line). Returns 0 when absent.
function lineOf(result) {
  if (!result || typeof result !== "object") return 0;
  const loc = Array.isArray(result.locations) ? result.locations[0] : null;
  const region = loc && loc.physicalLocation && loc.physicalLocation.region;
  if (region && Number.isFinite(Number(region.startLine))) return Number(region.startLine);
  if (result.start && Number.isFinite(Number(result.start.line))) return Number(result.start.line); // legacy
  return 0;
}

// SARIF result-level severity comes from the `level` field (error|warning|note);
// legacy semgrep json carries it under `extra.severity` (ERROR|WARNING|INFO).
// Returns the lowercased severity token, or "" when absent.
function rawSeverityOf(result) {
  if (!result || typeof result !== "object") return "";
  if (result.level) return String(result.level).toLowerCase();
  if (result.extra && result.extra.severity) return String(result.extra.severity).toLowerCase();
  return "";
}

// Map a raw Semgrep/SARIF severity onto the uniform finding severity. A SAST
// finding at ERROR level is a fail-class security gap; everything else is warn.
function findingSeverity(rawSeverity) {
  return severityRank(rawSeverity) >= SEVERITY_RANK.error ? "fail" : "warn";
}

// Parse a Semgrep SARIF payload (or legacy JSON with a top-level `results`
// array) into findings[]. Returns { findings, totals } or null when the payload
// is not a parseable Semgrep report.
//
// SARIF shape: { runs: [ { results: [ { ruleId, level, message: { text },
//   locations: [ { physicalLocation: { artifactLocation: { uri },
//   region: { startLine } } } ] } ] } ] }
// Legacy shape: { results: [ { check_id, path, start: { line },
//   extra: { message, severity } } ] }
function parseSemgrepReport(reportJsonOrText) {
  let report = reportJsonOrText;
  if (typeof report === "string") {
    if (!report.trim()) return null;
    try {
      report = JSON.parse(report);
    } catch {
      return null;
    }
  }
  if (!report || typeof report !== "object") return null;

  // Collect the result records from either the SARIF runs[].results or the
  // legacy top-level results[].
  let results = null;
  if (Array.isArray(report.runs)) {
    results = [];
    for (const run of report.runs) {
      if (run && Array.isArray(run.results)) results.push(...run.results);
    }
  } else if (Array.isArray(report.results)) {
    results = report.results;
  }
  // A payload with neither shape is not a Semgrep report. (An empty-but-valid
  // SARIF run yields results=[] => a clean parse with zero findings, NOT null.)
  if (results === null) return null;

  const findings = [];
  let failCount = 0;
  let warnCount = 0;
  for (const r of results) {
    const ruleId = ruleIdOf(r) || "rule";
    const file = fileOf(r);
    const rawSev = rawSeverityOf(r);
    const sev = findingSeverity(rawSev);
    const message = messageOf(r);
    const line = lineOf(r);
    if (sev === "fail") failCount += 1;
    else warnCount += 1;
    findings.push({
      check: "sast",
      file,
      // value = "<rule-id>::<normalized-message>" so the arch-checks default-branch
      // stable key (String(value)) yields the documented identity
      // sast:<file>:<rule-id>::<normalized-message> — rule + normalized message,
      // line/column omitted (churn-robust). The raw rule id is kept ahead of the
      // separator so the summary/diagnostics can recover it.
      value: `${ruleId}::${normalizeMessage(message)}`,
      ruleId,
      severity: sev,
      level: rawSev,
      line,
      message: `${ruleId}: ${message || "(no message)"} (${file || "?"}${line ? `:${line}` : ""})`,
    });
  }

  return {
    findings,
    totals: { total: findings.length, fail: failCount, warn: warnCount },
  };
}

// stableFindingDetail for the SAST dimension. Identity = the RULE id + the
// NORMALIZED message, omitting the exact line/column, so a cosmetic edit above a
// finding (or churn in the per-instance message text) does not mint a new key and
// reclassify it as "new" in ratchet mode. This is exactly the documented
// QUALITY_DIMENSIONS §3 choice: sast:<path>:<rule-id>:<normalized-message>.
//
// We reuse arch-checks.classifyFindingsAgainstBaseline / summarizeRatchet, whose
// stableFindingKey switches on finding.check and falls through to
// `String(finding.value)` for an unknown check. Because we pack the SAST
// identity into finding.value ("<rule-id>::<normalized-message>"), the
// default-branch key resolves to sast:<normalized-file>:<rule-id>::<normalized-message>
// — the churn-robust identity we want. sastStableDetail is exported for tests
// asserting this property (it mirrors what the default branch produces).
function sastStableDetail(finding) {
  return String(finding.value || "rule");
}

// ---------------------------------------------------------------------------
// 3. BOUNDED RUNNER (COORD-129 process-group-kill). Spawns Semgrep as its OWN
// process GROUP ({ detached: true }) so a negative-pid SIGKILL on timeout reaches
// the whole tree (Semgrep forks workers), bounds it with a timer, and SIGKILLs
// the group on timeout. Returns { status, timedOut, bound, stdout, stderr }.
// NEVER throws on a hung tool — it resolves with timedOut:true. `spawnImpl` is
// injectable so tests can prove the timeout path without installing Semgrep.
// COORD-486: the spawn/timer/group-kill loop is the shared
// runBoundedProcessGroup (bounded-process-runner.js); only the argv is local.
// ---------------------------------------------------------------------------
function runSemgrepBounded(
  { bin, repoRoot, configArg, timeoutMs } = {},
  deps = {},
) {
  // Emit SARIF to stdout so the adapter does not depend on the repo's reporter
  // config; --config defaults to "auto" (Semgrep's registry rule packs) but is
  // overridable. We pass the repo root as the scan target.
  const args = [
    "--sarif",
    "--quiet",
    "--config",
    configArg || "auto",
    repoRoot || ".",
  ];
  return runBoundedProcessGroup(
    { bin, args, cwd: repoRoot, timeoutMs, defaultTimeoutMs: DEFAULT_SAST_TIMEOUT_MS },
    deps,
  );
}

// ---------------------------------------------------------------------------
// 4. VERDICT. Two selectable modes (mirroring archGate / mutation-policy):
//   - "ratchet" (DEFAULT): fail only on NEW findings vs base (COORD-126), reusing
//                classifyFindingsAgainstBaseline + summarizeRatchet. So legacy
//                security debt is frictionless and only ADDED debt blocks.
//   - "threshold": fail when any finding's severity >= the configured floor
//                (audit-policy style); for repos that want an absolute bar.
// `baseFindings` is the SAST finding set on the base ref; supply [] when no base
// is available and the verdict degrades to "any new fail-class finding fails"
// (every current finding is new vs an empty base). Ratchet is the default.
// ---------------------------------------------------------------------------
function classifySast({ parsed, mode = "ratchet", threshold, baseFindings } = {}) {
  if (!parsed) {
    return { mode, result: "skip", available: false, reason: "no SAST report" };
  }
  const findings = parsed.findings || [];
  const totals = parsed.totals || {};

  if (mode === "threshold") {
    const floor = String(threshold || DEFAULT_SAST_THRESHOLD).toLowerCase();
    const floorRank = severityRank(floor) || SEVERITY_RANK.error;
    const atOrAbove = findings.filter((f) => severityRank(f.level) >= floorRank);
    return {
      mode: "threshold",
      result: atOrAbove.length > 0 ? "fail" : findings.length > 0 ? "warn" : "pass",
      available: true,
      threshold: floor,
      totals,
      atOrAbove: atOrAbove.length,
    };
  }

  // ratchet mode (DEFAULT). Reuse COORD-126 helpers verbatim. cfg/fileCount are
  // only used by summarizeRatchet for the absolute-mode passthrough fields; pass
  // a minimal cfg and the file count derived from the findings.
  const fileCount = new Set(findings.map((f) => f.file)).size;
  const summary = summarizeRatchet(findings, {}, fileCount, baseFindings || []);
  const split = classifyFindingsAgainstBaseline(findings, baseFindings || []);
  return {
    mode: "ratchet",
    result: summary.result, // "fail" only when a NEW fail-class finding exists
    available: true,
    totals,
    new: summary.new,
    preExisting: summary.preExisting,
    newFailCount: summary.newFailCount,
    newFindings: split.newFindings.length,
    preExistingFindings: split.preExistingFindings.length,
  };
}

// One-line, grep-friendly summary the runner prints + the gate signal records.
// ratchet:   "sast: fail mode=ratchet new=1 pre-existing=4 (findings=5 fail=2 warn=3)"
// threshold: "sast: pass mode=threshold floor=error at-or-above=0 (findings=5 fail=0 warn=5)"
// skipped:   "sast: skip (Semgrep not installed ...)"
function formatSastSummary(classification, skipReason) {
  if (!classification || classification.result === "skip") {
    const reason = (classification && classification.reason) || skipReason || "skipped";
    return `sast: skip (${reason})`;
  }
  const t = classification.totals || {};
  if (classification.mode === "threshold") {
    return (
      `sast: ${classification.result} mode=threshold floor=${classification.threshold} ` +
      `at-or-above=${classification.atOrAbove} ` +
      `(findings=${t.total || 0} fail=${t.fail || 0} warn=${t.warn || 0})`
    );
  }
  return (
    `sast: ${classification.result} mode=ratchet ` +
    `new=${classification.newFindings} pre-existing=${classification.preExistingFindings} ` +
    `(findings=${t.total || 0} fail=${t.fail || 0} warn=${t.warn || 0})`
  );
}

// ---------------------------------------------------------------------------
// runSastGate: the top-level adapter entry point that wires detection -> bounded
// run -> parse -> verdict. GRACEFUL by construction:
//   - tool absent             => { result: "skip", reason } (NEVER fail)
//   - tool ran but hung       => { result: "skip", reason: "timed out" } + the
//                                process group was SIGKILLed (NEVER blocks/fails)
//   - tool ran                => ratchet (default) / threshold verdict
// `deps` injects spawn/kill/fileExists/lookPath for dependency-free tests.
// ---------------------------------------------------------------------------
async function runSastGate(
  { repoRoot, mode = "ratchet", threshold, baseFindings, timeoutMs, configArg } = {},
  deps = {},
) {
  const detection = detectTool(repoRoot, deps);
  if (!detection.available) {
    return {
      ran: false,
      classification: { mode, result: "skip", available: false, reason: detection.reason },
      skipReason: detection.reason,
      summary: formatSastSummary({ result: "skip", reason: detection.reason }),
    };
  }

  const run = await runSemgrepBounded(
    { bin: detection.bin, repoRoot, configArg, timeoutMs },
    deps,
  );

  if (run.timedOut) {
    const reason = `Semgrep exceeded ${run.bound}ms and its process group was SIGKILLed (COORD-129) — skipped, not failed`;
    return {
      ran: true,
      timedOut: true,
      classification: { mode, result: "skip", available: false, reason },
      skipReason: reason,
      summary: formatSastSummary({ result: "skip", reason }),
    };
  }

  // Parse Semgrep's SARIF from stdout. A missing/garbage payload degrades to a
  // graceful skip (never a fail) — the run completed but produced no parseable
  // output. `readReport` is injectable so tests can supply a fixture directly.
  const raw = deps.readReport ? deps.readReport(run) : run.stdout;
  const parsed = parseSemgrepReport(raw);
  if (!parsed) {
    const reason = "Semgrep produced no parseable SARIF/JSON output — skipped, not failed";
    return {
      ran: true,
      classification: { mode, result: "skip", available: false, reason },
      skipReason: reason,
      summary: formatSastSummary({ result: "skip", reason }),
    };
  }

  const classification = classifySast({ parsed, mode, threshold, baseFindings });
  return {
    ran: true,
    classification,
    findings: parsed.findings,
    summary: formatSastSummary(classification),
  };
}

// CLI: `node sast-policy.js classify --root <repo> [--mode ratchet|threshold]
//        [--threshold error|warning] [--timeout-ms N] [--config auto|<path>]
//        [--base-report <path>]`
// Prints the one-line summary; exits non-zero ONLY on a hard "fail" verdict.
// A skip (tool absent / hung / no output) exits 0 — a missing tool NEVER fails
// the gate. --base-report (ratchet mode) supplies the base ref's Semgrep report
// from which the base finding set is parsed.
function runCli(argv, { stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const parsed = parseClassifyArgv(argv, err, CLASSIFY_CLI);
  if (!parsed.opts) return Promise.resolve(parsed.code);
  const opts = parsed.opts;
  // In ratchet mode, parse the base ref's report into the base finding set.
  let baseFindings = [];
  if (opts.mode === "ratchet" && opts.baseReportPath) {
    try {
      const baseParsed = parseSemgrepReport(fs.readFileSync(opts.baseReportPath, "utf8"));
      baseFindings = baseParsed ? baseParsed.findings : [];
    } catch {
      baseFindings = [];
    }
  }
  return runSastGate(
    {
      repoRoot: opts.repoRoot,
      mode: opts.mode,
      threshold: opts.threshold,
      timeoutMs: opts.timeoutMs,
      configArg: opts.configArg,
      baseFindings,
    },
    {},
  ).then((res) => {
    out.write(res.summary + "\n");
    return res.classification.result === "fail" ? 1 : 0;
  });
}

module.exports = {
  DEFAULT_SAST_TIMEOUT_MS,
  DEFAULT_SAST_THRESHOLD,
  SEVERITY_RANK,
  severityRank,
  resolveSemgrepBin,
  detectTool,
  normalizeMessage,
  parseSemgrepReport,
  sastStableDetail,
  classifySast,
  formatSastSummary,
  runSemgrepBounded,
  runSastGate,
  runCli,
};

function main() {
  // COORD-876: a leading --help prints the usage on stdout and exits 0.
  if (process.argv[2] === "--help") { runCli([], { stderr: process.stdout }); process.exitCode = 0; return; }
  runCli(process.argv.slice(2), {}).then((code) => {
    process.exitCode = code;
  });
}
if (require.main === module) main();
module.exports.main = main;
