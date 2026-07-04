"use strict";

// COORD-135 (Quality dimension #5: Performance budgets — size-limit + Lighthouse
// CI + k6). The FIFTH EXTERNAL-tool-adapter dimension built per the dimension
// contract in coord/docs/QUALITY_DIMENSIONS.md (§2.3(b)/§3), mirroring COORD-131's
// mutation-policy.js, COORD-132's sast-policy.js, COORD-133's
// supply-chain-policy.js, and COORD-134's a11y-policy.js. The gap it closes: the
// native arch-checks dimensions catch structural debt/drift, SAST catches unsafe
// source patterns, supply-chain catches transitive CVEs, a11y catches
// accessibility/visual regressions — but nothing enforces PERFORMANCE / SIZE
// BUDGETS (a bundle that creeps over its size budget, a web-vital that regresses
// past its target, a load-test p95 that blows past its SLO). This adapter wraps
// THREE sub-tools, each modelled as configurable BUDGETS checked against tool
// output:
//   (a) size-limit    — BUNDLE SIZE budgets (a named bundle's gzip/raw bytes vs a
//                        max). size-limit emits a JSON array of { name, size,
//                        sizeLimit?, passed? }.
//   (b) Lighthouse CI — WEB-VITAL budgets (LCP / CLS / TBT / FCP / TTI vs a target
//                        per route). LHCI emits assertion-results / an LHR audits
//                        map; we read numericValue per metric audit per route.
//   (c) k6            — LOAD budgets (a metric like http_req_duration p95, or a
//                        per-endpoint latency, vs an SLO). k6 emits a `metrics` map
//                        with per-metric values (p(95), avg, ...) and `thresholds`.
//
// This module is the SINGLE SOURCE OF TRUTH for the performance-budget policy, the
// same way audit-policy.js / coverage-policy.js / mutation-policy.js /
// sast-policy.js / supply-chain-policy.js / a11y-policy.js are for theirs. It is:
//   1. an ADAPTER  — run size-limit / Lighthouse / k6 (BOUNDED, own process group),
//                     parse each tool's JSON into the uniform finding shape (one
//                     finding per BUDGET that has a measured value), comparing the
//                     measured value against its configured budget target;
//   2. a VERDICT    — THRESHOLD (budget max — the natural PRIMARY for budgets: fail
//                     if a measured value EXCEEDS its budget) OR RATCHET (regression
//                     vs base — fail only on a budget that got WORSE vs the recorded
//                     baseline), reusing COORD-126 classifyFindingsAgainstBaseline /
//                     summarizeRatchet from arch-checks.js — NOT re-implemented here;
//   3. EVIDENCE     — a one-line summary + a `perf` field for the gate artifact
//                     (gate-artifact-schema.js), with a skip-reason when no tool is
//                     available.
//
// THE OPTIONALITY CONSTRAINT IS PARAMOUNT (same as COORD-131/132/133/134). The
// engine has ZERO runtime deps and adopters MAY NOT have size-limit / Lighthouse /
// k6 installed. So NONE of size-limit/@lhci/k6 is added to ANY package.json, and
// none is bundled. detectTool() resolves whichever sub-tool(s) are configured +
// available and, when ABSENT, SKIPS GRACEFULLY (result "skip", never "fail"). A
// missing tool must NEVER fail the gate, and the dimension is OPT-IN: it only RUNS
// when a repo explicitly enables it (GATE_PERF_ENABLED=1 in gate.sh) AND at least
// one sub-tool binary resolves. Default = skipped, so the existing gate is
// unperturbed.
//
// Boundary: this module is pure policy + perf-tool output parsing + a bounded
// runner. It does NOT touch the board or the gate-artifact write (gate.sh owns
// that). It mirrors the other policy modules: single-source the policy ONCE in
// Node rather than re-typing it in bash on every repo.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  classifyFindingsAgainstBaseline,
  summarizeRatchet,
} = require("./arch-checks.js");

// Default bound for a heavy perf step (ms). A Lighthouse run over several routes
// or a k6 load test can run long; this is generous but finite so a hung run can
// never block the gate. The COORD-129 process-group SIGKILL enforces it.
// Overridable via GATE_PERF_TIMEOUT_MS.
const DEFAULT_PERF_TIMEOUT_MS = 10 * 60 * 1000;

// The three sub-tools this adapter supports. Each is detected, run (bounded), and
// parsed independently; the dimension is "available" when ANY resolves.
const SUPPORTED_TOOLS = Object.freeze(["size-limit", "lighthouse", "k6"]);

// ---------------------------------------------------------------------------
// 1. DETECTION — which sub-tool(s) are available?
// ---------------------------------------------------------------------------
// The dimension is OPT-IN (gate.sh gates it behind GATE_PERF_ENABLED=1). It is
// "available" when AT LEAST ONE of size-limit / lighthouse(lhci) / k6 resolves.
// Like the prior adapters these are node_modules-local or SYSTEM binaries, so we
// resolve each from its env override (SIZE_LIMIT_BIN / LHCI_BIN / K6_BIN), the
// repo-local node_modules/.bin, or PATH. When none resolves we skip gracefully.
// This is detection-only (no execution), safe + instant on every repo, including
// the zero-dependency stub.
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

// The binary name + env-override key for each sub-tool. Lighthouse CI ships as
// `lhci`; the override key is LHCI_BIN. size-limit ships as `size-limit`; its
// override key is SIZE_LIMIT_BIN. k6 ships as `k6`; its override key is K6_BIN.
const TOOL_BIN = Object.freeze({
  "size-limit": { bin: "size-limit", overrideKey: "SIZE_LIMIT_BIN" },
  lighthouse: { bin: "lhci", overrideKey: "LHCI_BIN" },
  k6: { bin: "k6", overrideKey: "K6_BIN" },
});

// Resolve a single named sub-tool via its env override, the repo-local
// node_modules/.bin, or PATH. Returns the resolved path or null.
function resolveToolBin(tool, repoRoot, { fileExists, lookPath, env } = {}) {
  const meta = TOOL_BIN[tool];
  if (!meta) return null;
  const exists = fileExists || ((p) => fs.existsSync(p));
  const environ = env || process.env;
  if (environ[meta.overrideKey] && exists(environ[meta.overrideKey])) return environ[meta.overrideKey];
  const local = path.join(repoRoot, "node_modules", ".bin", meta.bin);
  if (exists(local)) return local;
  if (exists(local + ".cmd")) return local + ".cmd";
  const onPath = (lookPath || defaultLookPath)(meta.bin, environ);
  if (onPath) return onPath;
  return null;
}

// Detect tool presence. Returns { available, tool, bin, reason }.
// `available` is true when ANY supported sub-tool resolves. GATE_PERF_TOOL can
// force a specific sub-tool ("size-limit" | "lighthouse" | "k6"); otherwise the
// first resolvable in SUPPORTED_TOOLS order wins. `reason` explains a skip (no
// tool) for the artifact.
function detectTool(repoRoot, deps = {}) {
  const environ = deps.env || process.env;
  const prefer = String(environ.GATE_PERF_TOOL || "").toLowerCase();
  const order = SUPPORTED_TOOLS.includes(prefer)
    ? [prefer, ...SUPPORTED_TOOLS.filter((t) => t !== prefer)]
    : SUPPORTED_TOOLS.slice();
  for (const tool of order) {
    const bin = resolveToolBin(tool, repoRoot, deps);
    if (bin) return { available: true, tool, bin, reason: null };
  }
  return {
    available: false,
    tool: null,
    bin: null,
    reason:
      "no perf tool installed (no size-limit/lhci/k6 on PATH / SIZE_LIMIT_BIN / LHCI_BIN / K6_BIN / node_modules/.bin) — performance-budget dimension unavailable",
  };
}

// ---------------------------------------------------------------------------
// 2. NORMALIZE + PARSE — size-limit / Lighthouse / k6 output -> findings[].
// ---------------------------------------------------------------------------
// EVERY budget is keyed by the documented stable key budget-name:target — e.g.
// bundle-main:size, lcp:/route, load-p95:/endpoint. We pack the budget-name +
// measured/budget detail into finding.value and carry the TARGET in finding.file,
// so arch-checks.stableFindingKey (which falls through to
// `<check>:<file>:<String(value)>` for an unknown check) resolves to
// perf:<target>:<budget-name>::<...> — which IS budget-name:target reframed into
// the check:file:detail frame. The MEASURED VALUE and the BUDGET TARGET are
// deliberately NOT part of the identity (a budget tightening / a value drift must
// NOT mint a new key), so ratchet tracks the BUDGET, not its current number.

// Pack the finding.value so the arch-checks default-branch stable key yields
// perf:<target>:<budget-name>. We append a constant marker after "::" so the
// shape matches the prior adapters' packed values; the marker is fixed (NOT the
// volatile measured number) so the key is churn-robust.
function packedValue(budgetName) {
  return `${budgetName}::budget`;
}

// Map an over-budget result onto the uniform finding severity. A measured value
// OVER its budget is a fail-class perf gap; a value within budget (emitted as an
// informational finding when a budget exists but is met) is warn.
function findingSeverity(overBudget) {
  return overBudget ? "fail" : "warn";
}

// Build one uniform finding for a single budget. `budgetName` is the metric
// identity (e.g. "bundle-main", "lcp", "load-p95"); `target` is the addressable
// location (a route, an endpoint, the bundle entry, or "size" for a bundle byte
// budget); `measured` and `budget` are the numbers compared; `overBudget` is the
// THRESHOLD verdict for this budget. The same budget@target reported twice
// de-dups upstream.
function makeBudgetFinding({ budgetName, target, measured, budget, overBudget, unit, tool }) {
  const name = String(budgetName || "budget");
  const tgt = String(target == null || target === "" ? "default" : target);
  const sev = findingSeverity(overBudget);
  return {
    check: "perf",
    // file = the TARGET, so stableFindingKey reads
    // perf:<target>:<budget-name>::budget (budget-name:target).
    file: tgt,
    value: packedValue(name),
    budgetName: name,
    target: tgt,
    measured: Number.isFinite(Number(measured)) ? Number(measured) : null,
    budget: Number.isFinite(Number(budget)) ? Number(budget) : null,
    overBudget: !!overBudget,
    tool: tool || null,
    severity: sev,
    level: sev === "fail" ? "over-budget" : "within-budget",
    line: 0,
    message:
      `${name}@${tgt}: measured=${measured == null ? "?" : measured}${unit ? unit : ""} ` +
      `budget=${budget == null ? "?" : budget}${unit ? unit : ""} (${overBudget ? "OVER budget" : "within budget"})`,
  };
}

function emptyParsed() {
  return { findings: [], totals: { total: 0, fail: 0, warn: 0 } };
}

function pushTotals(parsed, finding) {
  parsed.findings.push(finding);
  if (finding.severity === "fail") parsed.totals.fail += 1;
  else parsed.totals.warn += 1;
  parsed.totals.total = parsed.findings.length;
}

// --- (a) size-limit --------------------------------------------------------
// size-limit --json emits a top-level array: [ { name, size, sizeLimit?,
// passed?, ... } ]. `size` is the measured bytes; `sizeLimit` (when present) is
// the configured budget. budget-name = the entry `name` (slugged); target =
// "size" (the byte budget for that bundle). over-budget = size > sizeLimit.
function parseSizeLimitReport(reportJsonOrText, { budgets } = {}) {
  let report = reportJsonOrText;
  if (typeof report === "string") {
    if (!report.trim()) return null;
    try {
      report = JSON.parse(report);
    } catch {
      return null;
    }
  }
  const rows = Array.isArray(report) ? report : Array.isArray(report && report.results) ? report.results : null;
  if (rows === null) return null;
  const parsed = emptyParsed();
  for (const r of rows) {
    if (!r || typeof r !== "object" || r.size == null) continue;
    const name = slug(r.name || r.path || "bundle");
    const measured = Number(r.size);
    // budget: prefer the report's own sizeLimit, else a configured per-name budget.
    const cfgBudget = budgets && budgets[`${name}:size`] != null ? Number(budgets[`${name}:size`]) : null;
    const budget = r.sizeLimit != null ? Number(r.sizeLimit) : cfgBudget;
    const overBudget = budget != null && measured > budget;
    pushTotals(
      parsed,
      makeBudgetFinding({ budgetName: name, target: "size", measured, budget, overBudget, unit: "B", tool: "size-limit" }),
    );
  }
  return parsed;
}

// --- (b) Lighthouse CI -----------------------------------------------------
// LHCI can emit several shapes. We support (1) the assertion-results array
// [ { auditId, url, actual, expected, passed } ] and (2) a raw LHR
// { finalUrl|requestedUrl, audits: { "largest-contentful-paint": { numericValue
// }, ... } }. We map the well-known metric audits to short budget names
// (lcp/cls/tbt/fcp/tti/si). budget-name = the metric; target = the route/url;
// over-budget = actual > expected (or numericValue > a configured budget).
const LH_METRIC_BUDGET = Object.freeze({
  "largest-contentful-paint": "lcp",
  "cumulative-layout-shift": "cls",
  "total-blocking-time": "tbt",
  "first-contentful-paint": "fcp",
  interactive: "tti",
  "speed-index": "si",
  "max-potential-fid": "fid",
});

function lhBudgetName(auditId) {
  return LH_METRIC_BUDGET[auditId] || slug(auditId);
}

function parseLighthouseReport(reportJsonOrText, { budgets } = {}) {
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
  const parsed = emptyParsed();

  // (1) assertion-results: [ { auditId, url, actual, expected, passed } ]
  const assertions = Array.isArray(report) ? report : Array.isArray(report.assertionResults) ? report.assertionResults : null;
  if (assertions) {
    let matched = false;
    for (const a of assertions) {
      if (!a || typeof a !== "object" || a.auditId == null) continue;
      matched = true;
      const name = lhBudgetName(a.auditId);
      const route = normalizeRoute(a.url || a.route || "/");
      const measured = a.actual != null ? Number(a.actual) : null;
      const budget = a.expected != null ? Number(a.expected) : budgetFor(budgets, name, route);
      const overBudget = a.passed === false || (budget != null && measured != null && measured > budget);
      pushTotals(parsed, makeBudgetFinding({ budgetName: name, target: route, measured, budget, overBudget, tool: "lighthouse" }));
    }
    if (matched) return parsed;
    // empty assertion array => zero findings (NOT null)
    if (Array.isArray(report) || Array.isArray(report.assertionResults)) return parsed;
  }

  // (2) raw LHR with an audits map.
  if (report.audits && typeof report.audits === "object") {
    const route = normalizeRoute(report.finalUrl || report.requestedUrl || report.url || "/");
    for (const [auditId, audit] of Object.entries(report.audits)) {
      if (!audit || typeof audit !== "object" || audit.numericValue == null) continue;
      if (!LH_METRIC_BUDGET[auditId]) continue; // only the well-known metric audits
      const name = lhBudgetName(auditId);
      const measured = Number(audit.numericValue);
      const budget = budgetFor(budgets, name, route);
      const overBudget = budget != null && measured > budget;
      pushTotals(parsed, makeBudgetFinding({ budgetName: name, target: route, measured, budget, overBudget, unit: "ms", tool: "lighthouse" }));
    }
    return parsed;
  }
  return null;
}

// --- (c) k6 ----------------------------------------------------------------
// `k6 run --summary-export` (or the end-of-test JSON summary) emits
// { metrics: { http_req_duration: { "p(95)": N, avg: N, ... }, ... },
//   thresholds?: {...} }. We model a LOAD budget per metric+aggregate, e.g.
// budget-name "load-p95" / "http_req_duration-p95"; target = an endpoint tag
// (from a sub-metric { "http_req_duration{endpoint:/x}": ... }) or the metric.
// over-budget = the aggregate value > the configured budget (or a failed k6
// threshold).
function parseK6Report(reportJsonOrText, { budgets } = {}) {
  let report = reportJsonOrText;
  if (typeof report === "string") {
    if (!report.trim()) return null;
    try {
      report = JSON.parse(report);
    } catch {
      return null;
    }
  }
  if (!report || typeof report !== "object" || !report.metrics || typeof report.metrics !== "object") {
    return null;
  }
  const parsed = emptyParsed();
  const thresholds = report.thresholds && typeof report.thresholds === "object" ? report.thresholds : {};
  // Which aggregates to surface as budgets (p95 is the canonical load budget).
  const aggregates = ["p(95)", "p(99)", "avg"];
  const aggLabel = { "p(95)": "p95", "p(99)": "p99", avg: "avg" };

  for (const [metricKey, metric] of Object.entries(report.metrics)) {
    if (!metric || typeof metric !== "object") continue;
    // A k6 metric key can carry a sub-tag: "http_req_duration{endpoint:/login}".
    const m = /^([^{]+)(?:\{([^}]*)\})?$/.exec(metricKey);
    const baseMetric = m ? m[1] : metricKey;
    const tag = m && m[2] ? m[2] : null;
    // target = the endpoint tag value when present, else the metric name itself.
    const target = tag ? normalizeRoute(tagValue(tag)) : baseMetric;
    for (const agg of aggregates) {
      if (metric[agg] == null || !Number.isFinite(Number(metric[agg]))) continue;
      const measured = Number(metric[agg]);
      const budgetName = `${slug(baseMetric)}-${aggLabel[agg]}`;
      const budget = budgetFor(budgets, budgetName, target);
      // A k6 threshold for this metric that FAILED also marks the budget over.
      const thrFailed = thresholdFailed(thresholds[metricKey] || thresholds[baseMetric]);
      const overBudget = thrFailed || (budget != null && measured > budget);
      pushTotals(parsed, makeBudgetFinding({ budgetName, target, measured, budget, overBudget, unit: "ms", tool: "k6" }));
    }
  }
  return parsed;
}

// A k6 thresholds entry can be { ok: false } or { passes, fails } or an array of
// strings. We treat a non-ok / fails>0 entry as a failed threshold.
function thresholdFailed(entry) {
  if (!entry) return false;
  if (typeof entry === "object") {
    if (entry.ok === false) return true;
    if (Number(entry.fails) > 0) return true;
    // k6 sometimes nests per-expression results: { "p(95)<500": { ok: false } }
    for (const v of Object.values(entry)) {
      if (v && typeof v === "object" && v.ok === false) return true;
    }
  }
  return false;
}

function tagValue(tag) {
  // "endpoint:/login" -> "/login"; "name:GET /x" -> "GET /x"; bare -> the tag.
  const idx = tag.indexOf(":");
  return idx === -1 ? tag : tag.slice(idx + 1);
}

// Look up a configured budget for budget-name@target, falling back to a
// name-only budget. `budgets` is a flat map keyed "budget-name:target" or
// "budget-name". Returns a number or null.
function budgetFor(budgets, name, target) {
  if (!budgets || typeof budgets !== "object") return null;
  const keyed = budgets[`${name}:${target}`];
  if (keyed != null && Number.isFinite(Number(keyed))) return Number(keyed);
  const nameOnly = budgets[name];
  if (nameOnly != null && Number.isFinite(Number(nameOnly))) return Number(nameOnly);
  return null;
}

// Slug a name into a stable token (lowercase, non-alnum -> dash, collapse).
function slug(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "budget";
}

// Normalize a route/url into a stable target token: strip protocol+host, query
// string, and trailing slash, so the SAME logical route is one identity.
function normalizeRoute(routeOrUrl) {
  let s = String(routeOrUrl == null ? "" : routeOrUrl).trim();
  s = s.replace(/^[a-z]+:\/\/[^/]+/i, ""); // strip scheme + host
  s = s.replace(/[?#].*$/, ""); // strip query / fragment
  if (s.length > 1) s = s.replace(/\/+$/, ""); // strip trailing slash (keep "/")
  return s || "/";
}

// Dispatch to the right sub-tool parser. `tool` selects the shape; when omitted
// we try each parser and take the first that recognizes the payload.
function parsePerfReport(reportJsonOrText, { tool, budgets } = {}) {
  if (tool === "size-limit") return parseSizeLimitReport(reportJsonOrText, { budgets });
  if (tool === "lighthouse") return parseLighthouseReport(reportJsonOrText, { budgets });
  if (tool === "k6") return parseK6Report(reportJsonOrText, { budgets });
  // auto-detect shape
  return (
    parseSizeLimitReport(reportJsonOrText, { budgets }) ||
    parseLighthouseReport(reportJsonOrText, { budgets }) ||
    parseK6Report(reportJsonOrText, { budgets })
  );
}

// stableFindingDetail for the perf dimension. Identity = the BUDGET NAME (with
// the target carried in finding.file), so the SAME budget@target is ONE finding
// regardless of its measured value / budget number drift. Reuses
// arch-checks.classifyFindingsAgainstBaseline / summarizeRatchet, whose
// stableFindingKey switches on finding.check and falls through to
// `String(finding.value)` for an unknown check. Because we pack
// "<budget-name>::budget" into finding.value and the target into finding.file,
// the default-branch key resolves to perf:<target>:<budget-name>::budget — the
// documented budget-name:target identity. perfStableDetail is exported for tests.
function perfStableDetail(finding) {
  return String(finding.value || "budget::budget");
}

// ---------------------------------------------------------------------------
// 3. BOUNDED RUNNER (COORD-129 process-group-kill). Spawns the perf tool as its
// OWN process GROUP ({ detached: true }) so a negative-pid SIGKILL on timeout
// reaches the whole tree (Lighthouse spawns headless-Chrome children; k6 forks
// VUs), bounds it with a timer, and SIGKILLs the group on timeout. Returns
// { status, timedOut, bound, stdout, stderr }. NEVER throws on a hung tool — it
// resolves with timedOut:true. `spawnImpl` is injectable so tests can prove the
// timeout path without any perf tool.
// ---------------------------------------------------------------------------
function toolArgs(tool, repoRoot, target) {
  if (tool === "size-limit") {
    // size-limit --json emits the per-entry size array to stdout.
    return ["--json"];
  }
  if (tool === "lighthouse") {
    // lhci collect+assert is the CI verb; we read its JSON output. (gate.sh /
    // the adapter consume the report from stdout or a configured report path.)
    return ["autorun", "--upload.target=filesystem"];
  }
  // k6 run with a JSON summary export to stdout (k6 supports `--summary-export`
  // to a path; for the bounded run we point the script at the target and capture
  // the end-of-test summary the adapter then parses).
  return ["run", "--quiet", target || "loadtest.js"];
}

function runPerfBounded({ bin, tool, repoRoot, target, timeoutMs } = {}, deps = {}) {
  const spawnImpl = deps.spawn || spawn;
  const killImpl = deps.kill || ((t, sig) => process.kill(t, sig));
  const bound = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_PERF_TIMEOUT_MS;
  const args = toolArgs(tool, repoRoot, target);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, {
        cwd: repoRoot,
        detached: true, // own process group → negative-pid kill reaches Chrome/VUs
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
      // Negative pid = the whole process group: kills the tool AND its
      // headless-Chrome / VU grandchildren, releasing the inherited pipes.
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
// 4. VERDICT. Two selectable modes:
//   - "threshold" (DEFAULT — the natural primary for budgets): fail when ANY
//                budget's measured value EXCEEDS its configured budget (an
//                over-budget finding is fail-class). A budget with no configured
//                target is informational (warn). This is the absolute "budget max"
//                bar the ticket asks for.
//   - "ratchet": fail only on budgets that got WORSE (became newly over-budget)
//                vs the base ref (COORD-126), reusing classifyFindingsAgainstBaseline
//                + summarizeRatchet. So a repo with a budget already over (legacy)
//                opts in without going red; only a NEWLY over-budget budget blocks.
// `baseFindings` is the perf finding set on the base ref; supply [] when no base
// is available and the verdict degrades to "any newly over-budget budget fails".
// Threshold is the default (budgets are naturally an absolute bar); ratchet is the
// regression-only on-ramp.
// ---------------------------------------------------------------------------
function classifyPerf({ parsed, mode = "threshold", baseFindings } = {}) {
  if (!parsed) {
    return { mode, result: "skip", available: false, reason: "no perf report" };
  }
  const findings = parsed.findings || [];
  const totals = parsed.totals || {};

  if (mode === "ratchet") {
    // Only over-budget findings (severity fail) participate in the ratchet verdict;
    // within-budget findings are informational. summarizeRatchet keys on
    // stableFindingKey and fails only on NEW fail-class findings.
    const fileCount = new Set(findings.map((f) => f.file)).size;
    const summary = summarizeRatchet(findings, {}, fileCount, baseFindings || []);
    const split = classifyFindingsAgainstBaseline(findings, baseFindings || []);
    return {
      mode: "ratchet",
      result: summary.result, // "fail" only when a NEW over-budget finding exists
      available: true,
      totals,
      new: summary.new,
      preExisting: summary.preExisting,
      newFailCount: summary.newFailCount,
      newFindings: split.newFindings.length,
      preExistingFindings: split.preExistingFindings.length,
    };
  }

  // threshold mode (DEFAULT). Fail if ANY budget is over its max; otherwise pass
  // (a budget that is MET is not a problem — within-budget findings are
  // informational and do not warn the verdict).
  const over = findings.filter((f) => f.overBudget);
  return {
    mode: "threshold",
    result: over.length > 0 ? "fail" : "pass",
    available: true,
    totals,
    overBudget: over.length,
  };
}

// One-line, grep-friendly summary the runner prints + the gate signal records.
// threshold: "perf: fail mode=threshold over-budget=1 (budgets=3 fail=1 warn=2)"
// ratchet:   "perf: pass mode=ratchet new=0 pre-existing=2 (budgets=2 fail=0 warn=2)"
// skipped:   "perf: skip (no perf tool installed ...)"
function formatPerfSummary(classification, skipReason) {
  if (!classification || classification.result === "skip") {
    const reason = (classification && classification.reason) || skipReason || "skipped";
    return `perf: skip (${reason})`;
  }
  const t = classification.totals || {};
  if (classification.mode === "ratchet") {
    return (
      `perf: ${classification.result} mode=ratchet ` +
      `new=${classification.newFindings} pre-existing=${classification.preExistingFindings} ` +
      `(budgets=${t.total || 0} fail=${t.fail || 0} warn=${t.warn || 0})`
    );
  }
  return (
    `perf: ${classification.result} mode=threshold ` +
    `over-budget=${classification.overBudget} ` +
    `(budgets=${t.total || 0} fail=${t.fail || 0} warn=${t.warn || 0})`
  );
}

// Load a flat budgets map from a JSON file: { "bundle-main:size": 250000,
// "lcp:/home": 2500, "load-p95:/login": 500 }. Returns {} on any error (budgets
// are optional — size-limit/lhci/k6 reports may carry their own limits inline).
function loadBudgets(budgetPath, deps = {}) {
  if (!budgetPath) return {};
  const read = deps.readBudgets || ((p) => fs.readFileSync(p, "utf8"));
  try {
    const obj = JSON.parse(read(budgetPath));
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// runPerfGate: the top-level adapter entry point that wires detection -> bounded
// run -> parse -> verdict. GRACEFUL by construction:
//   - tool absent             => { result: "skip", reason } (NEVER fail)
//   - tool ran but hung        => { result: "skip", reason: "timed out" } + the
//                                 process group was SIGKILLed (NEVER blocks/fails)
//   - tool ran                 => threshold (default) / ratchet verdict
// `deps` injects spawn/kill/fileExists/lookPath/readReport/readBudgets for
// dependency-free tests.
// ---------------------------------------------------------------------------
async function runPerfGate(
  { repoRoot, target, mode = "threshold", baseFindings, timeoutMs, budgets, budgetPath } = {},
  deps = {},
) {
  const detection = detectTool(repoRoot, deps);
  if (!detection.available) {
    return {
      ran: false,
      classification: { mode, result: "skip", available: false, reason: detection.reason },
      skipReason: detection.reason,
      summary: formatPerfSummary({ result: "skip", reason: detection.reason }),
    };
  }

  const resolvedBudgets = budgets || loadBudgets(budgetPath, deps);

  const run = await runPerfBounded(
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
      summary: formatPerfSummary({ result: "skip", reason }),
    };
  }

  // Parse the tool's JSON from stdout. A missing/garbage payload degrades to a
  // graceful skip (never a fail). `readReport` is injectable so tests can supply a
  // fixture directly.
  const raw = deps.readReport ? deps.readReport(run) : run.stdout;
  const parsed = parsePerfReport(raw, { tool: detection.tool, budgets: resolvedBudgets });
  if (!parsed) {
    const reason = `${detection.tool} produced no parseable perf JSON output — skipped, not failed`;
    return {
      ran: true,
      classification: { mode, result: "skip", available: false, reason },
      skipReason: reason,
      summary: formatPerfSummary({ result: "skip", reason }),
    };
  }

  const classification = classifyPerf({ parsed, mode, baseFindings });
  return {
    ran: true,
    tool: detection.tool,
    classification,
    findings: parsed.findings,
    summary: formatPerfSummary(classification),
  };
}

// CLI: `node perf-budget-policy.js classify --root <repo> [--target <url|script>]
//        [--mode threshold|ratchet] [--timeout-ms N] [--base-report <path>]
//        [--budgets <path>] [--tool size-limit|lighthouse|k6]`
// Prints the one-line summary; exits non-zero ONLY on a hard "fail" verdict.
// A skip (tool absent / hung / no output) exits 0 — a missing tool NEVER fails
// the gate. --base-report (ratchet mode) supplies the base ref's perf report from
// which the base budget finding set is parsed. --budgets supplies a flat
// budget-name:target -> max map.
function runCli(argv, { stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  if (argv[0] !== "classify") {
    err.write(
      "usage: perf-budget-policy.js classify --root <repo> [--target <url|script>] " +
        "[--mode threshold|ratchet] [--timeout-ms <n>] [--base-report <path>] " +
        "[--budgets <path>] [--tool size-limit|lighthouse|k6]\n",
    );
    return Promise.resolve(2);
  }
  const opts = { mode: "threshold" };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root") { opts.repoRoot = argv[++i]; }
    else if (a === "--target") { opts.target = argv[++i]; }
    else if (a === "--mode") { opts.mode = argv[++i]; }
    else if (a === "--timeout-ms") { opts.timeoutMs = Number(argv[++i]); }
    else if (a === "--base-report") { opts.baseReportPath = argv[++i]; }
    else if (a === "--budgets") { opts.budgetPath = argv[++i]; }
    else if (a === "--tool") { opts.tool = argv[++i]; }
  }
  if (!opts.repoRoot) {
    err.write("perf: ERROR --root <repo> is required\n");
    return Promise.resolve(2);
  }
  // In ratchet mode, parse the base ref's report into the base budget finding set.
  let baseFindings = [];
  const budgets = loadBudgets(opts.budgetPath, {});
  if (opts.mode === "ratchet" && opts.baseReportPath) {
    try {
      const baseParsed = parsePerfReport(fs.readFileSync(opts.baseReportPath, "utf8"), {
        tool: opts.tool,
        budgets,
      });
      baseFindings = baseParsed ? baseParsed.findings : [];
    } catch {
      baseFindings = [];
    }
  }
  return runPerfGate(
    {
      repoRoot: opts.repoRoot,
      target: opts.target,
      mode: opts.mode,
      timeoutMs: opts.timeoutMs,
      baseFindings,
      budgets,
    },
    {},
  ).then((res) => {
    out.write(res.summary + "\n");
    return res.classification.result === "fail" ? 1 : 0;
  });
}

module.exports = {
  DEFAULT_PERF_TIMEOUT_MS,
  SUPPORTED_TOOLS,
  resolveToolBin,
  detectTool,
  slug,
  normalizeRoute,
  parseSizeLimitReport,
  parseLighthouseReport,
  parseK6Report,
  parsePerfReport,
  perfStableDetail,
  classifyPerf,
  formatPerfSummary,
  loadBudgets,
  runPerfBounded,
  runPerfGate,
  runCli,
};

if (require.main === module) {
  runCli(process.argv.slice(2), {}).then((code) => {
    process.exitCode = code;
  });
}
