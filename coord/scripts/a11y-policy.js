"use strict";

// COORD-134 (Quality dimension #4: Accessibility — a11y scan + visual regression).
// The FOURTH EXTERNAL-tool-adapter dimension built per the dimension contract in
// coord/docs/QUALITY_DIMENSIONS.md (§2.3(b)/§3), mirroring COORD-131's
// mutation-policy.js, COORD-132's sast-policy.js, and COORD-133's
// supply-chain-policy.js. The gap it closes: the native arch-checks dimensions
// catch structural debt/drift, SAST catches unsafe source patterns, supply-chain
// catches transitive CVEs — but nothing enforces ACCESSIBILITY (axe-core / pa11y
// rule violations) or VISUAL REGRESSION (snapshot diffs beyond a threshold) for
// coord-ui + adopter FRONTENDS. This adapter does two things:
//   (a) A11Y SCAN — wraps pa11y or an axe-core runner (whichever resolves),
//       BOUNDED, and turns its JSON output (pa11y issues[] OR axe-core
//       violations[].nodes[]) into the uniform finding shape (one finding per
//       rule×selector/route).
//   (b) VISUAL REGRESSION — ingests a snapshot-diff report (route → changed
//       beyond a pixel/ratio threshold) as ratcheted findings. The actual image
//       diffing is tool-gated (a configured runner / a fixture diff report), so
//       NO pixel-diff library is bundled — absent runner ⇒ skip.
//
// This module is the SINGLE SOURCE OF TRUTH for the accessibility policy, the
// same way audit-policy.js / coverage-policy.js / mutation-policy.js /
// sast-policy.js / supply-chain-policy.js are for theirs. It is:
//   1. an ADAPTER  — run pa11y/axe (BOUNDED, own process group), parse its JSON
//                     into the uniform finding shape (one finding per
//                     rule×selector/route); AND ingest a visual-regression
//                     snapshot-diff report into the same finding shape;
//   2. a VERDICT    — RATCHET (the ticket says ratchet: fail only on NEW
//                     violations vs a base ref), reusing COORD-126
//                     classifyFindingsAgainstBaseline / summarizeRatchet from
//                     arch-checks.js — NOT re-implemented here; an optional
//                     `threshold` severity mode is also offered.
//   3. EVIDENCE     — a one-line summary + an `a11y` field for the gate artifact
//                     (gate-artifact-schema.js), with a skip-reason when the tool
//                     is unavailable.
//
// THE OPTIONALITY CONSTRAINT IS PARAMOUNT (same as COORD-131/132/133). The engine
// has ZERO runtime deps and adopters MAY NOT have pa11y/axe-core/playwright
// installed. So NONE of pa11y/axe-core/playwright is added to ANY package.json,
// and none is bundled. The adapter DETECTS whether a runner is available +
// configured and, when absent, SKIPS GRACEFULLY (result "skip", never "fail"). A
// missing tool must NEVER fail the gate, and the dimension is OPT-IN: it only
// RUNS when a repo explicitly enables it (GATE_A11Y_ENABLED=1 in gate.sh) AND a
// runner resolves. Default = skipped, so the existing gate is unperturbed. A
// frontend with no a11y tooling configured passes the gate unchanged.
//
// Boundary: this module is pure policy + a11y/visual-regression output parsing +
// a bounded runner. It does NOT touch the board or the gate-artifact write
// (gate.sh owns that). It mirrors the other policy modules: single-source the
// policy ONCE in Node rather than re-typing it in bash on every repo.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  classifyFindingsAgainstBaseline,
  summarizeRatchet,
} = require("./arch-checks.js");

// Default bound for the heavy a11y scan step (ms). A headless-browser a11y scan
// over many routes can be slow; this is generous but finite so a hung run can
// never block the gate. The COORD-129 process-group SIGKILL enforces it.
// Overridable via GATE_A11Y_TIMEOUT_MS.
const DEFAULT_A11Y_TIMEOUT_MS = 10 * 60 * 1000;

// Default severity floor for the optional `threshold` mode: any finding at or
// above this severity fails. RATCHET is the default verdict (the ticket says
// ratchet — see classifyA11y); threshold is offered for repos that want an
// absolute severity bar instead.
const DEFAULT_A11Y_THRESHOLD = "error";

// a11y severities, ranked. pa11y emits type=error|warning|notice; axe-core emits
// impact=critical|serious|moderate|minor. We map both onto a single ranked scale
// so the threshold mode and the fail/warn severity mapping are single-sourced.
// error / (critical|serious) => fail-class; everything else => warn.
const SEVERITY_RANK = Object.freeze({
  notice: 1,
  note: 1,
  info: 1,
  minor: 1,
  warning: 2,
  warn: 2,
  moderate: 2,
  serious: 3,
  error: 3,
  critical: 4,
});

function severityRank(sev) {
  return SEVERITY_RANK[String(sev || "").toLowerCase()] || 0;
}

// Map a raw pa11y/axe severity onto the uniform finding severity. An a11y
// violation at error / critical / serious is a fail-class accessibility gap;
// everything else (warning / moderate / notice / minor) is warn.
function findingSeverity(rawSeverity) {
  return severityRank(rawSeverity) >= SEVERITY_RANK.serious ? "fail" : "warn";
}

// ---------------------------------------------------------------------------
// 1. DETECTION — is an a11y runner available?
// ---------------------------------------------------------------------------
// The dimension is OPT-IN (gate.sh gates it behind GATE_A11Y_ENABLED=1). It is
// "available" when a pa11y OR axe runner binary resolves. Like Semgrep/Trivy,
// these are typically node_modules-local or SYSTEM binaries, so we resolve them
// from the env override (PA11Y_BIN / AXE_BIN), the repo-local node_modules/.bin,
// or PATH. When neither resolves we skip gracefully. This is detection-only (no
// execution), safe + instant on every repo, including the zero-dependency stub.
function defaultLookPath(bin, environ) {
  const PATH = (environ && environ.PATH) || "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      if (fs.existsSync(full)) return full;
      if (process.platform === "win32" && fs.existsSync(full + ".exe")) return full + ".exe";
    } catch {
      /* unreadable PATH entry — skip */
    }
  }
  return null;
}

// Resolve a single named runner ("pa11y" | "axe") via its env override, the
// repo-local node_modules/.bin, or PATH. Returns the resolved path or null.
function resolveRunnerBin(name, repoRoot, { fileExists, lookPath, env } = {}) {
  const exists = fileExists || ((p) => fs.existsSync(p));
  const environ = env || process.env;
  const overrideKey = `${name.toUpperCase()}_BIN`;
  if (environ[overrideKey] && exists(environ[overrideKey])) return environ[overrideKey];
  const local = path.join(repoRoot, "node_modules", ".bin", name);
  if (exists(local)) return local;
  if (exists(local + ".cmd")) return local + ".cmd";
  const onPath = (lookPath || defaultLookPath)(name, environ);
  if (onPath) return onPath;
  return null;
}

// Detect tool presence. Returns { available, tool, bin, reason }.
// `available` is true when EITHER pa11y or axe resolves. pa11y is preferred when
// both are present (it is the more common standalone CI a11y runner), but
// GATE_A11Y_RUNNER can force a specific one. `reason` explains a skip (no runner)
// for the artifact.
function detectTool(repoRoot, deps = {}) {
  const environ = deps.env || process.env;
  const prefer = String(environ.GATE_A11Y_RUNNER || "").toLowerCase();
  const order = prefer === "axe" ? ["axe", "pa11y"] : ["pa11y", "axe"];
  for (const name of order) {
    const bin = resolveRunnerBin(name, repoRoot, deps);
    if (bin) return { available: true, tool: name, bin, reason: null };
  }
  return {
    available: false,
    tool: null,
    bin: null,
    reason:
      "no a11y runner installed (no pa11y/axe on PATH / PA11Y_BIN / AXE_BIN / node_modules/.bin) — accessibility dimension unavailable",
  };
}

// ---------------------------------------------------------------------------
// 2a. NORMALIZE + PARSE — pa11y / axe-core a11y JSON -> findings[].
// ---------------------------------------------------------------------------
// Both runners report a rule id + a DOM selector (or a page route/url). The
// stable key is rule-id:selector-or-route, so identity tracks THE RULE FIRING AT
// A LOCATION rather than the exact text-context snippet around it. We normalize
// the selector/route consistently (lowercase, strip volatile :nth-child indices /
// trailing query-strings / numeric ids) so per-instance churn does not mint a new
// key under ratchet mode.
//
// pa11y shape:  { issues?: [...] } OR a top-level [...] array, each issue:
//   { code, type (error|warning|notice), selector, context, message }
//   (pa11y may also carry a per-issue `pageUrl`/`url` when multiple pages run)
// axe-core shape: { violations: [ { id, impact, nodes: [ { target: [sel],
//   html } ] } ], url? }  (axe groups by rule, with one node per occurrence)

// Normalize a selector or route into a stable token. Strips volatile per-instance
// detail: lowercases, collapses whitespace, strips :nth-child(N)/[N] index
// detail, query-strings, and bare numeric id segments — so a row reorder or a
// changed numeric id does not reclassify a pre-existing finding as "new".
function normalizeSelector(selectorOrRoute) {
  return String(selectorOrRoute == null ? "" : selectorOrRoute)
    .toLowerCase()
    .trim()
    // strip a query string / fragment from a route
    .replace(/[?#].*$/, "")
    // strip :nth-child(7) / :nth-of-type(3) volatile positional pseudo-classes
    .replace(/:nth-(child|of-type|last-child|last-of-type)\([^)]*\)/g, "")
    // strip [3] / :eq(3) positional index detail
    .replace(/\[\d+\]/g, "")
    .replace(/:eq\(\d+\)/g, "")
    // collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

// Pull the rule id from a pa11y issue (code) or axe violation (id). Returns "".
function ruleIdOf(record) {
  if (!record || typeof record !== "object") return "";
  if (record.code) return String(record.code); // pa11y
  if (record.id) return String(record.id); // axe rule
  if (record.ruleId) return String(record.ruleId);
  return "";
}

// Build the packed finding.value so the arch-checks default-branch stable key
// (String(value)) yields the documented identity
// a11y:<file-or-route>:<rule-id>::<normalized-selector> — rule + normalized
// selector/route, context/snippet omitted (churn-robust). NOTE: arch-checks keys
// on `<check>:<file>:<detail>`; we put the ROUTE in finding.file and pack
// "<rule-id>::<normalized-selector>" into finding.value, so the key reads
// a11y:<route>:<rule-id>::<normalized-selector> — which IS rule-id:selector-or-route
// reframed into the check:file:detail frame (the same identity the ticket asks
// for). When no selector is present (page-level / visual issue), the route itself
// is the location and the normalized selector falls back to the route.
function packedValue(ruleId, normalizedSelector) {
  return `${ruleId}::${normalizedSelector}`;
}

function pushFinding(findings, totals, { ruleId, route, selector, severity, message }) {
  const id = String(ruleId || "rule");
  const routeKey = normalizeSelector(route) || "/";
  // The selector is the precise location; when absent (page-level), fall back to
  // the route so the key is still stable + addressable.
  const normSel = normalizeSelector(selector) || routeKey;
  const sevToken = String(severity || "").toLowerCase();
  const sev = findingSeverity(sevToken);
  if (sev === "fail") totals.fail += 1;
  else totals.warn += 1;
  findings.push({
    check: "a11y",
    // file = the route/page, so stableFindingKey reads
    // a11y:<route>:<rule-id>::<normalized-selector> (rule-id:selector-or-route).
    file: routeKey,
    value: packedValue(id, normSel),
    ruleId: id,
    route: routeKey,
    selector: normSel,
    severity: sev,
    level: sevToken,
    line: 0,
    message: `${id}: ${message || "(no message)"} (${routeKey} ${normSel})`,
  });
}

// Parse a pa11y or axe-core a11y JSON payload into findings[]. De-dups at the
// stable-key level (the same rule on the same selector/route reported twice
// collapses to ONE finding). Returns { findings, totals } or null when the
// payload is neither shape.
function parseA11yReport(reportJsonOrText) {
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

  const findings = [];
  const totals = { total: 0, fail: 0, warn: 0 };
  const seen = new Set();
  const dedupedPush = (rec) => {
    const id = String(rec.ruleId || "rule");
    const routeKey = normalizeSelector(rec.route) || "/";
    const normSel = normalizeSelector(rec.selector) || routeKey;
    const key = `${id}:${routeKey}:${normSel}`;
    if (seen.has(key)) return;
    seen.add(key);
    pushFinding(findings, totals, rec);
  };

  // pa11y: a top-level array of issues, OR { issues: [...] }, OR multi-page
  // results { results: { "<url>": [issues] } }.
  let isPa11y = false;
  if (Array.isArray(report)) {
    isPa11y = true;
    for (const issue of report) {
      dedupedPush({
        ruleId: ruleIdOf(issue),
        route: issue.pageUrl || issue.url || report.documentTitle || "/",
        selector: issue.selector,
        severity: issue.type,
        message: issue.message,
      });
    }
  } else if (Array.isArray(report.issues)) {
    isPa11y = true;
    for (const issue of report.issues) {
      dedupedPush({
        ruleId: ruleIdOf(issue),
        route: issue.pageUrl || issue.url || report.pageUrl || report.url || "/",
        selector: issue.selector,
        severity: issue.type,
        message: issue.message,
      });
    }
  } else if (report.results && typeof report.results === "object" && !Array.isArray(report.violations)) {
    // pa11y multi-page: { results: { "<url>": [ issue, ... ] } }
    isPa11y = true;
    for (const [url, issues] of Object.entries(report.results)) {
      if (!Array.isArray(issues)) continue;
      for (const issue of issues) {
        dedupedPush({
          ruleId: ruleIdOf(issue),
          route: issue.pageUrl || issue.url || url,
          selector: issue.selector,
          severity: issue.type,
          message: issue.message,
        });
      }
    }
  }

  if (!isPa11y && Array.isArray(report.violations)) {
    // axe-core: { violations: [ { id, impact, nodes: [ { target, html } ] } ], url }
    const route = report.url || (report.testEngine && report.testEngine.url) || "/";
    for (const v of report.violations) {
      const nodes = Array.isArray(v.nodes) && v.nodes.length ? v.nodes : [{}];
      for (const n of nodes) {
        const target = Array.isArray(n.target) ? n.target.join(" ") : n.target;
        dedupedPush({
          ruleId: ruleIdOf(v),
          route,
          selector: target,
          severity: v.impact,
          message: v.help || v.description,
        });
      }
    }
  } else if (!isPa11y && !Array.isArray(report.violations)) {
    return null; // neither a pa11y nor an axe-core report
  }

  totals.total = findings.length;
  return { findings, totals };
}

// ---------------------------------------------------------------------------
// 2b. VISUAL REGRESSION — snapshot-diff report -> findings[].
// ---------------------------------------------------------------------------
// We model visual regression as a snapshot-diff finding (route → changed beyond
// threshold), ALSO ratcheted. The actual image diffing is kept tool-gated: this
// module does NOT bundle a pixel-diff library — it INGESTS a snapshot-diff report
// (e.g. produced by a configured playwright/reg-suit/jest-image-snapshot runner,
// or a fixture diff report). Each changed route whose diff ratio exceeds the
// threshold becomes a `check: "a11y"` finding under a synthetic "visual-regression"
// rule id, keyed by route, so it flows through the SAME ratchet as the a11y scan.
//
// Report shape (tolerant): { diffs: [ { route|name, diffRatio|mismatch|diffPixels,
//   threshold? , status? } ] } OR a top-level [...] of the same. A diff is a
// fail-class finding when its ratio exceeds the (per-diff or global) threshold;
// an unchanged/below-threshold diff is informational (not emitted as a fail).
const DEFAULT_VISUAL_DIFF_THRESHOLD = 0; // ratio > 0 => changed (strict by default)

function diffRatioOf(diff) {
  if (!diff || typeof diff !== "object") return 0;
  for (const k of ["diffRatio", "mismatch", "misMatchPercentage", "ratio"]) {
    if (diff[k] != null && Number.isFinite(Number(diff[k]))) {
      // misMatchPercentage is 0..100; the rest are 0..1. Normalize to 0..1.
      const v = Number(diff[k]);
      return k === "misMatchPercentage" ? v / 100 : v;
    }
  }
  // diffPixels with totalPixels => derive a ratio.
  if (diff.diffPixels != null && diff.totalPixels) {
    return Number(diff.diffPixels) / Number(diff.totalPixels);
  }
  return 0;
}

// Parse a visual-regression snapshot-diff report into findings[]. `globalThreshold`
// is the ratio above which a diff is "changed beyond threshold" (fail-class); a
// per-diff `threshold` overrides it. Returns { findings, totals } or null when the
// payload is not a recognizable diff report. A diff with status "new"/"changed"
// above threshold is fail-class; "unchanged"/below-threshold is warn (informational).
function parseVisualRegressionReport(reportJsonOrText, { globalThreshold } = {}) {
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

  let diffs = null;
  if (Array.isArray(report)) diffs = report;
  else if (Array.isArray(report.diffs)) diffs = report.diffs;
  else if (Array.isArray(report.results)) diffs = report.results;
  if (diffs === null) return null;

  const floor = Number.isFinite(Number(globalThreshold))
    ? Number(globalThreshold)
    : DEFAULT_VISUAL_DIFF_THRESHOLD;

  const findings = [];
  const totals = { total: 0, fail: 0, warn: 0 };
  const seen = new Set();
  for (const d of diffs) {
    if (!d || typeof d !== "object") continue;
    const route = normalizeSelector(d.route || d.name || d.id || d.snapshot) || "/";
    const ratio = diffRatioOf(d);
    const perThreshold = Number.isFinite(Number(d.threshold)) ? Number(d.threshold) : floor;
    const status = String(d.status || "").toLowerCase();
    // "changed beyond threshold" => fail-class. An explicit pass/unchanged status
    // OR a ratio at-or-below threshold => warn (informational, not a regression).
    const changed =
      status === "fail" ||
      status === "changed" ||
      status === "new" ||
      (status !== "pass" && status !== "unchanged" && ratio > perThreshold);
    const sev = changed ? "fail" : "warn";
    // stable key: visual-regression:<route> — route-keyed, churn-robust (the
    // ratio is volatile, so it is NOT part of the identity; the route is).
    const key = `visual-regression:${route}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (sev === "fail") totals.fail += 1;
    else totals.warn += 1;
    findings.push({
      check: "a11y",
      file: route,
      value: packedValue("visual-regression", route),
      ruleId: "visual-regression",
      route,
      selector: route,
      severity: sev,
      level: changed ? "error" : "notice",
      line: 0,
      message: `visual-regression: ${route} diff=${ratio.toFixed(4)} threshold=${perThreshold} (${
        changed ? "changed beyond threshold" : "within threshold"
      })`,
    });
  }
  totals.total = findings.length;
  return { findings, totals };
}

// stableFindingDetail for the a11y dimension. Identity = the RULE id + the
// NORMALIZED selector/route, omitting volatile per-instance context, so a row
// reorder / numeric-id change does not mint a new key and reclassify a finding as
// "new" in ratchet mode. This is exactly the documented ticket key
// rule-id:selector-or-route. Reuses arch-checks.classifyFindingsAgainstBaseline /
// summarizeRatchet, whose stableFindingKey switches on finding.check and falls
// through to `String(finding.value)` for an unknown check. Because we pack
// "<rule-id>::<normalized-selector>" into finding.value and the route into
// finding.file, the default-branch key resolves to
// a11y:<route>:<rule-id>::<normalized-selector> — the documented identity.
// a11yStableDetail is exported for tests asserting this property.
function a11yStableDetail(finding) {
  return String(finding.value || "rule");
}

// ---------------------------------------------------------------------------
// 3. BOUNDED RUNNER (COORD-129 process-group-kill). Spawns the a11y runner as its
// OWN process GROUP ({ detached: true }) so a negative-pid SIGKILL on timeout
// reaches the whole tree (headless-browser children), bounds it with a timer, and
// SIGKILLs the group on timeout. Returns { status, timedOut, bound, stdout,
// stderr }. NEVER throws on a hung tool — it resolves with timedOut:true.
// `spawnImpl` is injectable so tests can prove the timeout path without a runner.
// ---------------------------------------------------------------------------
function runnerArgs(tool, target) {
  if (tool === "axe") {
    // axe CLI: scan a URL/file, emit JSON to stdout.
    return [target || ".", "--stdout"];
  }
  // pa11y: emit JSON reporter to stdout for the target url/file.
  return ["--reporter", "json", target || "."];
}

function runA11yBounded(
  { bin, tool, repoRoot, target, timeoutMs } = {},
  deps = {},
) {
  const spawnImpl = deps.spawn || spawn;
  const killImpl = deps.kill || ((t, sig) => process.kill(t, sig));
  const bound = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_A11Y_TIMEOUT_MS;
  const args = runnerArgs(tool, target);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, {
        cwd: repoRoot,
        detached: true, // own process group → negative-pid kill reaches browsers
        env: process.env,
      });
    } catch (err) {
      resolve({ status: null, timedOut: false, bound, stdout: "", stderr: String(err), spawnError: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    if (child.stdout) child.stdout.on("data", (d) => { stdout += d; });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      // Negative pid = the whole process group: kills the runner AND its
      // headless-browser grandchildren, releasing the inherited pipes.
      try { killImpl(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, bound);
    if (timer.unref) timer.unref();
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, timedOut, bound, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, timedOut, bound, stdout, stderr: `${stderr}\n${err}` });
    });
  });
}

// ---------------------------------------------------------------------------
// 4. VERDICT. RATCHET is the ticket-mandated default (mirroring sast-policy):
//   - "ratchet" (DEFAULT): fail only on NEW violations vs base (COORD-126), reusing
//                classifyFindingsAgainstBaseline + summarizeRatchet. So a frontend
//                with legacy a11y debt opts in without going red; only NEWLY-
//                introduced violations (a11y or visual-regression) block.
//   - "threshold": fail when any finding's severity >= the configured floor
//                (default error ⇒ error/critical/serious fail); for repos that
//                want an absolute bar.
// `baseFindings` is the a11y+visual finding set on the base ref; supply [] when no
// base is available and the verdict degrades to "any new fail-class finding fails".
// The a11y-scan findings and the visual-regression findings are ratcheted TOGETHER
// (one combined finding set), keyed by their respective stable keys.
// ---------------------------------------------------------------------------
function classifyA11y({ parsed, mode = "ratchet", threshold, baseFindings } = {}) {
  if (!parsed) {
    return { mode, result: "skip", available: false, reason: "no a11y report" };
  }
  const findings = parsed.findings || [];
  const totals = parsed.totals || {};

  if (mode === "threshold") {
    const floor = String(threshold || DEFAULT_A11Y_THRESHOLD).toLowerCase();
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
  // only used by summarizeRatchet for the absolute-mode passthrough fields; pass a
  // minimal cfg and the (route) count derived from the findings.
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
// ratchet:   "a11y: fail mode=ratchet new=1 pre-existing=4 (findings=5 fail=2 warn=3)"
// threshold: "a11y: pass mode=threshold floor=error at-or-above=0 (findings=5 fail=0 warn=5)"
// skipped:   "a11y: skip (no a11y runner installed ...)"
function formatA11ySummary(classification, skipReason) {
  if (!classification || classification.result === "skip") {
    const reason = (classification && classification.reason) || skipReason || "skipped";
    return `a11y: skip (${reason})`;
  }
  const t = classification.totals || {};
  if (classification.mode === "threshold") {
    return (
      `a11y: ${classification.result} mode=threshold floor=${classification.threshold} ` +
      `at-or-above=${classification.atOrAbove} ` +
      `(findings=${t.total || 0} fail=${t.fail || 0} warn=${t.warn || 0})`
    );
  }
  return (
    `a11y: ${classification.result} mode=ratchet ` +
    `new=${classification.newFindings} pre-existing=${classification.preExistingFindings} ` +
    `(findings=${t.total || 0} fail=${t.fail || 0} warn=${t.warn || 0})`
  );
}

// Combine an a11y-scan finding set with a visual-regression finding set into ONE
// parsed object (both ratcheted together). Either may be null/absent; the result
// is null only when BOTH are absent.
function combineParsed(a11yParsed, visualParsed) {
  if (!a11yParsed && !visualParsed) return null;
  const findings = []
    .concat(a11yParsed ? a11yParsed.findings : [])
    .concat(visualParsed ? visualParsed.findings : []);
  const totals = {
    total: findings.length,
    fail: findings.filter((f) => f.severity === "fail").length,
    warn: findings.filter((f) => f.severity === "warn").length,
  };
  return { findings, totals };
}

// ---------------------------------------------------------------------------
// runA11yGate: the top-level adapter entry point that wires detection -> bounded
// run -> parse (a11y scan + visual-regression) -> verdict. GRACEFUL by construction:
//   - runner absent           => { result: "skip", reason } (NEVER fail)
//   - runner ran but hung      => { result: "skip", reason: "timed out" } + the
//                                 process group was SIGKILLed (NEVER blocks/fails)
//   - runner ran               => ratchet (default) / threshold verdict
// The visual-regression report is INGESTED (tool-gated): a `visualReport` is
// supplied (by gate.sh from a configured runner / fixture) — absent ⇒ the a11y
// scan stands alone. `deps` injects spawn/kill/fileExists/lookPath/readReport for
// dependency-free tests.
// ---------------------------------------------------------------------------
async function runA11yGate(
  { repoRoot, target, mode = "ratchet", threshold, baseFindings, timeoutMs, visualReport, visualThreshold } = {},
  deps = {},
) {
  // Visual regression is ingested independently of the a11y runner: even if the
  // a11y runner is absent, a supplied snapshot-diff report can still be ratcheted.
  // But per the ticket the a11y SCAN is the primary deliverable, so the dimension
  // is "available" iff the a11y runner resolves OR a visual report was supplied.
  const visualParsed = visualReport
    ? parseVisualRegressionReport(visualReport, { globalThreshold: visualThreshold })
    : null;

  const detection = detectTool(repoRoot, deps);
  if (!detection.available) {
    // No a11y runner. If a visual-regression report was supplied we can still
    // ratchet it alone; otherwise skip the whole dimension gracefully.
    if (visualParsed) {
      const classification = classifyA11y({ parsed: visualParsed, mode, threshold, baseFindings });
      return {
        ran: true,
        tool: "visual-only",
        a11yAvailable: false,
        classification,
        findings: visualParsed.findings,
        summary: formatA11ySummary(classification),
      };
    }
    return {
      ran: false,
      classification: { mode, result: "skip", available: false, reason: detection.reason },
      skipReason: detection.reason,
      summary: formatA11ySummary({ result: "skip", reason: detection.reason }),
    };
  }

  const run = await runA11yBounded(
    { bin: detection.bin, tool: detection.tool, repoRoot, target, timeoutMs },
    deps,
  );

  if (run.timedOut) {
    const reason = `${detection.tool} exceeded ${run.bound}ms and its process group was SIGKILLed (COORD-129) — skipped, not failed`;
    return {
      ran: true,
      timedOut: true,
      classification: { mode, result: "skip", available: false, reason },
      skipReason: reason,
      summary: formatA11ySummary({ result: "skip", reason }),
    };
  }

  // Parse the a11y runner's JSON from stdout. A missing/garbage payload degrades
  // to a graceful skip (never a fail) — UNLESS a visual report was supplied, in
  // which case we still ratchet the visual findings. `readReport` is injectable so
  // tests can supply a fixture directly.
  const raw = deps.readReport ? deps.readReport(run) : run.stdout;
  const a11yParsed = parseA11yReport(raw);
  if (!a11yParsed && !visualParsed) {
    const reason = `${detection.tool} produced no parseable a11y JSON output — skipped, not failed`;
    return {
      ran: true,
      classification: { mode, result: "skip", available: false, reason },
      skipReason: reason,
      summary: formatA11ySummary({ result: "skip", reason }),
    };
  }

  const parsed = combineParsed(a11yParsed, visualParsed);
  const classification = classifyA11y({ parsed, mode, threshold, baseFindings });
  return {
    ran: true,
    tool: detection.tool,
    a11yAvailable: true,
    classification,
    findings: parsed.findings,
    summary: formatA11ySummary(classification),
  };
}

// CLI: `node a11y-policy.js classify --root <repo> [--target <url|dir>]
//        [--mode ratchet|threshold] [--threshold error|serious|...]
//        [--timeout-ms N] [--base-report <path>] [--visual-report <path>]
//        [--visual-threshold <ratio>]`
// Prints the one-line summary; exits non-zero ONLY on a hard "fail" verdict.
// A skip (runner absent / hung / no output) exits 0 — a missing tool NEVER fails
// the gate. --base-report (ratchet mode) supplies the base ref's a11y report (and
// optionally a base visual report appended) from which the base finding set is
// parsed. --visual-report ingests a snapshot-diff report (tool-gated; absent ⇒ the
// a11y scan stands alone).
function runCli(argv, { stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  if (argv[0] !== "classify") {
    err.write(
      "usage: a11y-policy.js classify --root <repo> [--target <url|dir>] " +
        "[--mode ratchet|threshold] [--threshold <sev>] [--timeout-ms <n>] " +
        "[--base-report <path>] [--visual-report <path>] [--visual-threshold <ratio>]\n",
    );
    return Promise.resolve(2);
  }
  const opts = { mode: "ratchet" };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root") { opts.repoRoot = argv[++i]; }
    else if (a === "--target") { opts.target = argv[++i]; }
    else if (a === "--mode") { opts.mode = argv[++i]; }
    else if (a === "--threshold") { opts.threshold = argv[++i]; }
    else if (a === "--timeout-ms") { opts.timeoutMs = Number(argv[++i]); }
    else if (a === "--base-report") { opts.baseReportPath = argv[++i]; }
    else if (a === "--visual-report") { opts.visualReportPath = argv[++i]; }
    else if (a === "--visual-threshold") { opts.visualThreshold = Number(argv[++i]); }
  }
  if (!opts.repoRoot) {
    err.write("a11y: ERROR --root <repo> is required\n");
    return Promise.resolve(2);
  }
  // In ratchet mode, parse the base ref's report(s) into the base finding set.
  // The base finding set combines a base a11y report (--base-report) and, when a
  // visual report is in play, the base lives in the same diff history; for the CLI
  // we treat --base-report as the a11y base. A repo with no base degrades to
  // "every current finding is new".
  let baseFindings = [];
  if (opts.mode === "ratchet" && opts.baseReportPath) {
    try {
      const baseParsed = parseA11yReport(fs.readFileSync(opts.baseReportPath, "utf8"));
      baseFindings = baseParsed ? baseParsed.findings : [];
    } catch {
      baseFindings = [];
    }
  }
  let visualReport = null;
  if (opts.visualReportPath) {
    try {
      visualReport = fs.readFileSync(opts.visualReportPath, "utf8");
    } catch {
      visualReport = null;
    }
  }
  return runA11yGate(
    {
      repoRoot: opts.repoRoot,
      target: opts.target,
      mode: opts.mode,
      threshold: opts.threshold,
      timeoutMs: opts.timeoutMs,
      baseFindings,
      visualReport,
      visualThreshold: opts.visualThreshold,
    },
    {},
  ).then((res) => {
    out.write(res.summary + "\n");
    return res.classification.result === "fail" ? 1 : 0;
  });
}

module.exports = {
  DEFAULT_A11Y_TIMEOUT_MS,
  DEFAULT_A11Y_THRESHOLD,
  DEFAULT_VISUAL_DIFF_THRESHOLD,
  SEVERITY_RANK,
  severityRank,
  resolveRunnerBin,
  detectTool,
  normalizeSelector,
  parseA11yReport,
  parseVisualRegressionReport,
  combineParsed,
  a11yStableDetail,
  classifyA11y,
  formatA11ySummary,
  runA11yBounded,
  runA11yGate,
  runCli,
};

if (require.main === module) {
  runCli(process.argv.slice(2), {}).then((code) => {
    process.exitCode = code;
  });
}
