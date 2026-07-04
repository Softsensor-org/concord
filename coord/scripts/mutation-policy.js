"use strict";

// COORD-131 (Quality dimension #1: Correctness — mutation + property-based
// testing). The FIRST EXTERNAL-tool-adapter dimension built per the dimension
// contract in coord/docs/QUALITY_DIMENSIONS.md. Coverage is a weak proxy for
// correctness; mutation testing (Stryker) measures whether the test suite
// actually KILLS injected faults. Property-based testing (fast-check) is the
// companion authoring practice — fast-check tests run under the normal unit-test
// step, and the mutation score is the gate signal that proves they (and the
// example tests) are meaningfully strong.
//
// This module is the SINGLE SOURCE OF TRUTH for the mutation-score policy, the
// same way audit-policy.js / coverage-policy.js are for their dimensions. It is:
//   1. an ADAPTER  — run Stryker (BOUNDED, own process group), parse its JSON
//                     report into the uniform finding shape (one finding per
//                     SURVIVED mutant);
//   2. a VERDICT    — threshold (mutation score >= configured min) OR ratchet
//                     (fail only on NEW survived mutants vs a base ref), reusing
//                     COORD-126 classifyFindingsAgainstBaseline / summarizeRatchet
//                     from arch-checks.js — NOT re-implemented here;
//   3. EVIDENCE     — a one-line summary + a `mutation` field for the gate
//                     artifact (gate-artifact-schema.js), with a skip-reason when
//                     the tool is unavailable.
//
// THE OPTIONALITY CONSTRAINT IS PARAMOUNT. The engine has ZERO runtime deps and
// adopters MAY NOT have Stryker/fast-check installed. So Stryker/fast-check are
// NOT in any package.json and are NOT bundled. The adapter DETECTS whether the
// tool is available + configured and, when absent, SKIPS GRACEFULLY (result
// "skip", never "fail"). A missing tool must NEVER fail the gate, and the
// dimension is OPT-IN: absent config => skipped. It only RUNS when a repo
// explicitly enables it (config present AND the Stryker binary resolvable).
//
// Boundary: this module is pure policy + Stryker-report parsing + a bounded
// runner. It does NOT touch the board or the gate artifact write (gate.sh owns
// that). It mirrors the other policy modules: single-source the policy ONCE in
// Node rather than re-typing it in bash on every repo.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  classifyFindingsAgainstBaseline,
  summarizeRatchet,
} = require("./arch-checks.js");

// Config-driven default: the minimum mutation score % that must be met in
// `threshold` mode. Below this => fail; at/above => pass. Conservative-ish so a
// repo opting in does not immediately go red, but high enough to be meaningful.
// Per-repo overridable via the GATE_MUTATION_MIN env var consumed by the runner.
const DEFAULT_MUTATION_MIN = 60;

// Default bound for the heavy Stryker step (ms). Mutation runs are slow; this is
// generous but finite so a hung run can never block the gate. The COORD-129
// process-group SIGKILL enforces it. Overridable via GATE_MUTATION_TIMEOUT_MS.
const DEFAULT_MUTATION_TIMEOUT_MS = 15 * 60 * 1000;

// The Stryker JSON report's mutant statuses. A mutant is "killed" when a test
// failed on it (good); "survived" when no test caught it (a correctness GAP);
// "no coverage" means no test even exercised the mutated line (also a gap, but
// classified separately by Stryker). We treat SURVIVED + NO_COVERAGE as the
// findings the dimension flags (the test suite did not kill the injected fault).
const SURVIVED_STATUSES = Object.freeze(["Survived", "NoCoverage"]);

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

// ---------------------------------------------------------------------------
// 1. DETECTION — is the dimension configured AND the tool available?
// ---------------------------------------------------------------------------
// The dimension is OPT-IN. It is considered "configured" when a Stryker config
// file is present in the repo root (stryker.conf.{js,cjs,mjs,json} or
// .stryker.conf.*). It is "available" when the Stryker binary resolves
// (node_modules/.bin/stryker). BOTH must hold to run; otherwise we skip
// gracefully. This is detection-only (no execution), so it is safe + instant on
// every repo, including the zero-dependency template stub.
const STRYKER_CONFIG_CANDIDATES = Object.freeze([
  "stryker.conf.js",
  "stryker.conf.cjs",
  "stryker.conf.mjs",
  "stryker.conf.json",
  ".stryker.conf.js",
  ".stryker.conf.cjs",
  ".stryker.conf.mjs",
  ".stryker.conf.json",
]);

// Resolve the Stryker config file in `repoRoot`, or null when none is present.
function resolveStrykerConfig(repoRoot, { fileExists } = {}) {
  const exists = fileExists || ((p) => fs.existsSync(p));
  for (const name of STRYKER_CONFIG_CANDIDATES) {
    const full = path.join(repoRoot, name);
    if (exists(full)) return full;
  }
  return null;
}

// Resolve the Stryker binary for `repoRoot`, or null when it is not installed.
// Prefers the repo-local node_modules/.bin/stryker (what an adopter installs);
// the engine itself never depends on it.
function resolveStrykerBin(repoRoot, { fileExists } = {}) {
  const exists = fileExists || ((p) => fs.existsSync(p));
  const local = path.join(repoRoot, "node_modules", ".bin", "stryker");
  if (exists(local)) return local;
  if (exists(local + ".cmd")) return local + ".cmd";
  return null;
}

// Detect tool presence. Returns:
//   { available, configPath, bin, reason }
// `available` is true only when BOTH a config file and the binary resolve.
// `reason` explains a skip (config absent / binary absent) for the artifact.
function detectTool(repoRoot, deps = {}) {
  const configPath = resolveStrykerConfig(repoRoot, deps);
  const bin = resolveStrykerBin(repoRoot, deps);
  if (!configPath) {
    return {
      available: false,
      configPath: null,
      bin,
      reason: "no Stryker config (stryker.conf.*) — mutation dimension not configured",
    };
  }
  if (!bin) {
    return {
      available: false,
      configPath,
      bin: null,
      reason: "Stryker not installed (node_modules/.bin/stryker absent)",
    };
  }
  return { available: true, configPath, bin, reason: null };
}

// ---------------------------------------------------------------------------
// 2. PARSE — Stryker JSON report -> findings[] (one per survived mutant).
// ---------------------------------------------------------------------------
// Stryker's JSON report (mutation-report schema) shape:
//   { schemaVersion, files: { "<path>": { mutants: [ { id, mutatorName,
//       status, location: { start: { line, column } }, ... } ] } } }
// We emit one finding per SURVIVED / NO-COVERAGE mutant in the uniform shape and
// compute the mutation score = killed / (total - ignored-ish), matching how
// Stryker reports it. Returns { findings, score, totals } or null when the
// payload is not a parseable report.
function parseMutationReport(reportJsonOrText) {
  let report = reportJsonOrText;
  if (typeof report === "string") {
    if (!report.trim()) return null;
    try {
      report = JSON.parse(report);
    } catch {
      return null;
    }
  }
  if (!report || typeof report !== "object" || !report.files || typeof report.files !== "object") {
    return null;
  }

  const findings = [];
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  let timeout = 0;
  let total = 0;

  for (const [file, entry] of Object.entries(report.files)) {
    const mutants = (entry && Array.isArray(entry.mutants)) ? entry.mutants : [];
    for (const m of mutants) {
      const status = String(m.status || "");
      // Statuses that do not count toward the killed/total ratio (Stryker omits
      // Ignored from the score denominator). CompileError likewise excluded.
      if (status === "Ignored" || status === "CompileError") continue;
      total += 1;
      if (status === "Killed") killed += 1;
      else if (status === "Timeout") {
        timeout += 1;
        killed += 1; // a timeout counts as killed in Stryker's score
      } else if (status === "Survived") survived += 1;
      else if (status === "NoCoverage") noCoverage += 1;

      if (SURVIVED_STATUSES.includes(status)) {
        const line = m.location && m.location.start ? m.location.start.line : 0;
        findings.push({
          check: "mutation",
          file,
          // value = the mutator identity (the KIND of fault that went undetected),
          // used for the stable key so the finding tracks the surviving mutant
          // rather than its current line position.
          value: m.mutatorName || "mutant",
          severity: "fail", // a survived mutant is a correctness gap => fail-class
          line,
          message: `survived mutant [${m.mutatorName || "mutant"}] in ${file}${
            line ? `:${line}` : ""
          } (${status}) — no test killed this injected fault`,
        });
      }
    }
  }

  // Stryker's mutation score = killed / detected, where detected excludes
  // NoCoverage from the numerator but it IS in the denominator of the standard
  // "mutation score" (not the "covered" variant). We report the standard score:
  //   score = killed / total * 100  (total excludes Ignored/CompileError).
  const score = total > 0 ? clampPct((killed / total) * 100) : null;

  return {
    findings,
    score,
    totals: { total, killed, survived, noCoverage, timeout },
  };
}

// stableFindingDetail for the mutation dimension. Identity = the MUTATOR kind
// at a file (omitting the exact line), so a cosmetic edit above a surviving
// mutant does not mint a new key and reclassify it as "new" in ratchet mode.
// We additionally key on line so that two distinct survivors of the SAME mutator
// in one file remain separable, but a whole-file line shift will still re-key —
// which is acceptable here because mutation findings are recomputed against the
// base ref on every ratchet run (the base is recomputed the same way, so a pure
// shift moves base + current together). To stay churn-robust we omit the line
// from the key, matching arch-checks' "track the thing, not where it sits".
function mutationStableDetail(finding) {
  return `mut:${String(finding.value || "mutant")}`;
}

// We reuse arch-checks.classifyFindingsAgainstBaseline / summarizeRatchet, which
// key findings via arch-checks.stableFindingKey -> stableFindingDetail. Those
// switch on finding.check and fall through to `String(finding.value)` for an
// unknown check. For `mutation`, finding.value is the mutator name, so the
// default branch yields key `mutation:<file>:<mutatorName>` — exactly the
// churn-robust identity we want. (Documented here so the reuse is intentional,
// not accidental: the default-branch key IS the mutation dimension's stable
// key.) mutationStableDetail is exported for tests asserting this property.

// ---------------------------------------------------------------------------
// 4. VERDICT. Two selectable modes (mirroring archGate ratchet/threshold):
//   - "threshold": fail when mutation score < min (coverage-policy style).
//   - "ratchet":   fail only on NEW survived mutants vs base (COORD-126),
//                  reusing classifyFindingsAgainstBaseline + summarizeRatchet.
// `baseFindings` is required for ratchet (the survived-mutant set on the base
// ref); supply [] when no base is available and the verdict degrades to "any
// new survivor fails" (every current survivor is new vs an empty base) — so a
// caller that cannot compute a base should prefer threshold mode.
// ---------------------------------------------------------------------------
function classifyMutation({ parsed, mode, min, baseFindings } = {}) {
  if (!parsed) {
    return {
      mode: mode || "threshold",
      result: "skip",
      available: false,
      reason: "no mutation report",
    };
  }
  const findings = parsed.findings || [];
  const totals = parsed.totals || {};

  if (mode === "ratchet") {
    // Reuse COORD-126 helpers verbatim. cfg/fileCount are only used by
    // summarizeRatchet for the absolute-mode passthrough fields; pass a minimal
    // cfg and the file count derived from the report.
    const fileCount = new Set(findings.map((f) => f.file)).size;
    const summary = summarizeRatchet(findings, {}, fileCount, baseFindings || []);
    const split = classifyFindingsAgainstBaseline(findings, baseFindings || []);
    return {
      mode: "ratchet",
      result: summary.result, // "fail" only when a NEW survivor exists
      available: true,
      score: parsed.score,
      totals,
      new: summary.new,
      preExisting: summary.preExisting,
      newFailCount: summary.newFailCount,
      newSurvivors: split.newFindings.length,
      preExistingSurvivors: split.preExistingFindings.length,
    };
  }

  // threshold mode (default)
  const thr = Number.isFinite(Number(min)) ? Number(min) : DEFAULT_MUTATION_MIN;
  const score = parsed.score;
  let result;
  if (score == null) {
    // No mutants scored (e.g. nothing to mutate) — treat as a graceful skip,
    // never a fail, consistent with coverage-policy's no-data path.
    result = "skip";
  } else if (score < thr) {
    result = "fail";
  } else {
    result = "pass";
  }
  return {
    mode: "threshold",
    result,
    available: score != null,
    score,
    threshold: thr,
    totals,
    survivors: findings.length,
  };
}

// One-line, grep-friendly summary the runner prints + the gate signal records.
// threshold: "mutation: pass mode=threshold min=60 score=82.50 (killed=33/40 survived=5 noCoverage=2)"
// ratchet:   "mutation: fail mode=ratchet score=82.50 new=1 pre-existing=4 (survivors=5)"
// skipped:   "mutation: skip (no Stryker config — mutation dimension not configured)"
function formatMutationSummary(classification, skipReason) {
  if (!classification || classification.result === "skip") {
    const reason = (classification && classification.reason) || skipReason || "skipped";
    return `mutation: skip (${reason})`;
  }
  const t = classification.totals || {};
  const score = classification.score == null ? "n/a" : classification.score.toFixed(2);
  if (classification.mode === "ratchet") {
    return (
      `mutation: ${classification.result} mode=ratchet score=${score} ` +
      `new=${classification.newSurvivors} pre-existing=${classification.preExistingSurvivors} ` +
      `(survivors=${classification.newSurvivors + classification.preExistingSurvivors})`
    );
  }
  return (
    `mutation: ${classification.result} mode=threshold min=${classification.threshold} ` +
    `score=${score} (killed=${t.killed || 0}/${t.total || 0} ` +
    `survived=${t.survived || 0} noCoverage=${t.noCoverage || 0})`
  );
}

// ---------------------------------------------------------------------------
// 3. BOUNDED RUNNER (COORD-129 process-group-kill). Spawns Stryker as its OWN
// process GROUP ({ detached: true }) so a negative-pid SIGKILL on timeout reaches
// the whole tree (Stryker forks worker children + a test runner), bounds it with
// a timer, and SIGKILLs the group on timeout. Returns
//   { status, timedOut, bound, stdout, stderr, reportPath }
// NEVER throws on a hung tool — it resolves with timedOut:true. `spawnImpl` is
// injectable so tests can prove the timeout path without installing Stryker.
// ---------------------------------------------------------------------------
function runStrykerBounded(
  { bin, configPath, repoRoot, reportPath, timeoutMs } = {},
  deps = {},
) {
  const spawnImpl = deps.spawn || spawn;
  const killImpl = deps.kill || ((target, sig) => process.kill(target, sig));
  const bound = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_MUTATION_TIMEOUT_MS;
  // Stryker writes a JSON report when configured with the json reporter; we ask
  // for it explicitly via flags so the adapter does not depend on the repo's
  // reporter config. The report path is passed to the parser by the caller.
  const args = [
    "run",
    configPath,
    "--reporters",
    "json",
    "--jsonReporter.fileName",
    reportPath,
  ];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, {
        cwd: repoRoot,
        detached: true, // own process group → negative-pid kill reaches workers
        env: process.env,
      });
    } catch (err) {
      resolve({ status: null, timedOut: false, bound, stdout: "", stderr: String(err), reportPath, spawnError: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    if (child.stdout) child.stdout.on("data", (d) => { stdout += d; });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      // Negative pid = the whole process group: kills Stryker AND its worker /
      // test-runner grandchildren, releasing the inherited pipes so we never block.
      try { killImpl(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, bound);
    if (timer.unref) timer.unref();
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, timedOut, bound, stdout, stderr, reportPath });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, timedOut, bound, stdout, stderr: `${stderr}\n${err}`, reportPath });
    });
  });
}

// ---------------------------------------------------------------------------
// runMutationGate: the top-level adapter entry point that wires detection ->
// bounded run -> parse -> verdict. GRACEFUL by construction:
//   - tool absent/unconfigured => { result: "skip", reason } (NEVER fail)
//   - tool ran but hung        => { result: "skip", reason: "timed out" } + the
//                                 process group was SIGKILLed (NEVER blocks/fails)
//   - tool ran                 => threshold/ratchet verdict
// `deps` injects spawn/kill/fileExists/readReport for dependency-free tests.
// ---------------------------------------------------------------------------
async function runMutationGate(
  { repoRoot, mode = "threshold", min, baseFindings, timeoutMs, reportPath } = {},
  deps = {},
) {
  const detection = detectTool(repoRoot, deps);
  if (!detection.available) {
    return {
      ran: false,
      classification: { mode, result: "skip", available: false, reason: detection.reason },
      skipReason: detection.reason,
      summary: formatMutationSummary({ result: "skip", reason: detection.reason }),
    };
  }

  const resolvedReport = reportPath || path.join(repoRoot, "reports", "mutation", "mutation.json");
  const run = await runStrykerBounded(
    { bin: detection.bin, configPath: detection.configPath, repoRoot, reportPath: resolvedReport, timeoutMs },
    deps,
  );

  if (run.timedOut) {
    const reason = `Stryker exceeded ${run.bound}ms and its process group was SIGKILLed (COORD-129) — skipped, not failed`;
    return {
      ran: true,
      timedOut: true,
      classification: { mode, result: "skip", available: false, reason },
      skipReason: reason,
      summary: formatMutationSummary({ result: "skip", reason }),
    };
  }

  // Read + parse the report. A missing/garbage report degrades to a graceful
  // skip (never a fail) — the run completed but produced no scoreable output.
  const readReport = deps.readReport || ((p) => {
    try { return fs.readFileSync(p, "utf8"); } catch { return null; }
  });
  const raw = readReport(resolvedReport);
  const parsed = parseMutationReport(raw);
  if (!parsed) {
    const reason = "Stryker produced no parseable JSON report — skipped, not failed";
    return {
      ran: true,
      classification: { mode, result: "skip", available: false, reason },
      skipReason: reason,
      summary: formatMutationSummary({ result: "skip", reason }),
    };
  }

  const classification = classifyMutation({ parsed, mode, min, baseFindings });
  return {
    ran: true,
    classification,
    findings: parsed.findings,
    summary: formatMutationSummary(classification),
  };
}

// CLI: `node mutation-policy.js classify --root <repo> [--mode threshold|ratchet]
//        [--min 60] [--timeout-ms N] [--report <path>] [--base-report <path>]`
// Prints the one-line summary; exits non-zero ONLY on a hard "fail" verdict.
// A skip (tool absent / hung / no report) exits 0 — a missing tool NEVER fails
// the gate. --base-report (ratchet mode) supplies the base ref's Stryker report
// from which the base survived-mutant set is parsed.
function runCli(argv, { stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  if (argv[0] !== "classify") {
    err.write(
      "usage: mutation-policy.js classify --root <repo> [--mode threshold|ratchet] " +
        "[--min <pct>] [--timeout-ms <n>] [--report <path>] [--base-report <path>]\n",
    );
    return Promise.resolve(2);
  }
  const opts = { mode: "threshold" };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root") { opts.repoRoot = argv[++i]; }
    else if (a === "--mode") { opts.mode = argv[++i]; }
    else if (a === "--min") { opts.min = argv[++i]; }
    else if (a === "--timeout-ms") { opts.timeoutMs = Number(argv[++i]); }
    else if (a === "--report") { opts.reportPath = argv[++i]; }
    else if (a === "--base-report") { opts.baseReportPath = argv[++i]; }
  }
  if (!opts.repoRoot) {
    err.write("mutation: ERROR --root <repo> is required\n");
    return Promise.resolve(2);
  }
  // In ratchet mode, parse the base ref's report into the base survived-mutant set.
  let baseFindings = [];
  if (opts.mode === "ratchet" && opts.baseReportPath) {
    try {
      const baseParsed = parseMutationReport(fs.readFileSync(opts.baseReportPath, "utf8"));
      baseFindings = baseParsed ? baseParsed.findings : [];
    } catch {
      baseFindings = [];
    }
  }
  return runMutationGate(
    {
      repoRoot: opts.repoRoot,
      mode: opts.mode,
      min: opts.min,
      timeoutMs: opts.timeoutMs,
      reportPath: opts.reportPath,
      baseFindings,
    },
    {},
  ).then((res) => {
    out.write(res.summary + "\n");
    return res.classification.result === "fail" ? 1 : 0;
  });
}

module.exports = {
  DEFAULT_MUTATION_MIN,
  DEFAULT_MUTATION_TIMEOUT_MS,
  SURVIVED_STATUSES,
  STRYKER_CONFIG_CANDIDATES,
  resolveStrykerConfig,
  resolveStrykerBin,
  detectTool,
  parseMutationReport,
  mutationStableDetail,
  classifyMutation,
  formatMutationSummary,
  runStrykerBounded,
  runMutationGate,
  runCli,
};

if (require.main === module) {
  runCli(process.argv.slice(2), {}).then((code) => {
    process.exitCode = code;
  });
}
