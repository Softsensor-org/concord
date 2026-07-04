"use strict";

// COORD-135 (Quality dimension #5: Performance budgets — size-limit + Lighthouse
// CI + k6). Tests for the EXTERNAL-tool-adapter. CRITICAL: this suite MUST NOT
// require size-limit/@lhci/k6 to be installed — every external interaction is a
// FAKE (injected spawn/kill/fileExists/lookPath/readReport) or a fixture tool
// report. The engine keeps ZERO runtime deps and these tests prove the adapter is
// graceful when the tool is absent, correct when it ran (threshold), ratcheted vs
// a base, stable-keyed by budget-name:target, and bounded when it hangs.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const {
  SUPPORTED_TOOLS,
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
} = require("./perf-budget-policy.js");

const { stableFindingKey } = require("./arch-checks.js");

// ---------------------------------------------------------------------------
// Fixtures: a size-limit JSON report, an LHCI report (assertion-results + raw
// LHR), and a k6 summary-export.
// ---------------------------------------------------------------------------
function sizeLimitReport(entries) {
  // size-limit --json emits [ { name, size, sizeLimit? } ].
  return entries.map((e) => ({ name: e.name, size: e.size, sizeLimit: e.sizeLimit }));
}

function lhciAssertions(rows) {
  // LHCI assertion-results array.
  return { assertionResults: rows.map((r) => ({ auditId: r.auditId, url: r.url, actual: r.actual, expected: r.expected, passed: r.passed })) };
}

function lhrReport(url, audits) {
  return { finalUrl: url, audits };
}

function k6Summary(metrics, thresholds) {
  return { metrics, thresholds: thresholds || {} };
}

// ---------------------------------------------------------------------------
// 1. DETECTION + GRACEFUL SKIP — the #1 requirement: a missing tool NEVER fails.
// ---------------------------------------------------------------------------
test("detectTool: skips when no perf tool is installed (tool unavailable)", () => {
  const d = detectTool("/repo", { fileExists: () => false, lookPath: () => null, env: {} });
  assert.equal(d.available, false);
  assert.match(d.reason, /no perf tool installed/);
});

test("detectTool: available when size-limit resolves on PATH", () => {
  const d = detectTool("/repo", {
    fileExists: () => false,
    lookPath: (n) => (n === "size-limit" ? "/usr/bin/size-limit" : null),
    env: { PATH: "/usr/bin" },
  });
  assert.equal(d.available, true);
  assert.equal(d.tool, "size-limit");
  assert.equal(d.bin, "/usr/bin/size-limit");
});

test("detectTool: GATE_PERF_TOOL=k6 forces k6 ordering; K6_BIN override wins", () => {
  const d = detectTool("/repo", {
    fileExists: (p) => p === "/opt/k6",
    lookPath: () => null,
    env: { GATE_PERF_TOOL: "k6", K6_BIN: "/opt/k6" },
  });
  assert.equal(d.available, true);
  assert.equal(d.tool, "k6");
  assert.equal(d.bin, "/opt/k6");
});

test("detectTool: lighthouse resolves via the lhci binary (LHCI_BIN)", () => {
  const d = detectTool("/repo", {
    fileExists: (p) => p === "/opt/lhci",
    lookPath: () => null,
    env: { GATE_PERF_TOOL: "lighthouse", LHCI_BIN: "/opt/lhci" },
  });
  assert.equal(d.available, true);
  assert.equal(d.tool, "lighthouse");
});

test("runPerfGate: tool ABSENT => result 'skip', the gate is NOT failed (CLI exits 0)", async () => {
  const res = await runPerfGate(
    { repoRoot: "/repo", mode: "threshold" },
    { fileExists: () => false, lookPath: () => null, env: {} },
  );
  assert.equal(res.ran, false);
  assert.equal(res.classification.result, "skip");
  assert.match(res.summary, /^perf: skip/);
  assert.notEqual(res.classification.result, "fail");
});

test("runCli: missing tool exits 0 (a missing external tool MUST NOT fail the gate)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf-absent-"));
  const saved = {
    PATH: process.env.PATH,
    SIZE_LIMIT_BIN: process.env.SIZE_LIMIT_BIN,
    LHCI_BIN: process.env.LHCI_BIN,
    K6_BIN: process.env.K6_BIN,
  };
  try {
    process.env.PATH = root; // a dir guaranteed to NOT contain any perf tool
    delete process.env.SIZE_LIMIT_BIN;
    delete process.env.LHCI_BIN;
    delete process.env.K6_BIN;
    let out = "";
    const code = await runCli(
      ["classify", "--root", root, "--mode", "threshold"],
      { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } },
    );
    assert.equal(code, 0, "missing tool must exit 0 (skip, never fail)");
    assert.match(out, /^perf: skip/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. PARSE — all three sub-tool report shapes -> findings, with over/within budget.
// ---------------------------------------------------------------------------
test("parsePerfReport: returns null for empty/garbage input", () => {
  assert.equal(parsePerfReport(""), null);
  assert.equal(parsePerfReport("not json"), null);
  assert.equal(parsePerfReport({ nothing: true }), null);
});

test("parseSizeLimitReport: bundle OVER its sizeLimit => over-budget fail; under => within (warn)", () => {
  const parsed = parseSizeLimitReport(
    sizeLimitReport([
      { name: "main", size: 300000, sizeLimit: 250000 }, // over
      { name: "vendor", size: 90000, sizeLimit: 100000 }, // under
    ]),
  );
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.totals.fail, 1);
  assert.equal(parsed.totals.warn, 1);
  const over = parsed.findings.find((f) => f.overBudget);
  assert.equal(over.budgetName, "main");
  assert.equal(over.target, "size");
  assert.equal(over.tool, "size-limit");
});

test("parseSizeLimitReport: a configured budget (no inline sizeLimit) is honored", () => {
  const parsed = parseSizeLimitReport([{ name: "main", size: 300000 }], { budgets: { "main:size": 200000 } });
  assert.equal(parsed.findings[0].overBudget, true);
  assert.equal(parsed.findings[0].budget, 200000);
});

test("parseLighthouseReport: assertion-results (web vitals) -> findings; actual>expected => fail", () => {
  const parsed = parseLighthouseReport(
    lhciAssertions([
      { auditId: "largest-contentful-paint", url: "https://x/home", actual: 3200, expected: 2500, passed: false },
      { auditId: "cumulative-layout-shift", url: "https://x/home", actual: 0.05, expected: 0.1, passed: true },
    ]),
  );
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.totals.fail, 1);
  const lcp = parsed.findings.find((f) => f.budgetName === "lcp");
  assert.equal(lcp.target, "/home"); // host stripped
  assert.equal(lcp.overBudget, true);
});

test("parseLighthouseReport: raw LHR audits map with a configured budget per metric:route", () => {
  const parsed = parseLighthouseReport(
    lhrReport("https://x/dash", {
      "largest-contentful-paint": { numericValue: 4000 },
      "total-blocking-time": { numericValue: 100 },
      "unrelated-audit": { numericValue: 999 }, // ignored (not a known metric)
    }),
    { budgets: { "lcp:/dash": 2500, "tbt:/dash": 300 } },
  );
  assert.equal(parsed.findings.length, 2); // only the two known metrics
  const lcp = parsed.findings.find((f) => f.budgetName === "lcp");
  assert.equal(lcp.overBudget, true); // 4000 > 2500
  const tbt = parsed.findings.find((f) => f.budgetName === "tbt");
  assert.equal(tbt.overBudget, false); // 100 < 300
});

test("parseK6Report: load p95 over the budget => over-budget; per-endpoint tag becomes the target", () => {
  const parsed = parseK6Report(
    k6Summary({
      "http_req_duration{endpoint:/login}": { "p(95)": 650, avg: 200 },
      http_req_duration: { "p(95)": 400, avg: 150 },
    }),
    { budgets: { "http-req-duration-p95:/login": 500, "http-req-duration-p95:http_req_duration": 9999 } },
  );
  const loginP95 = parsed.findings.find((f) => f.target === "/login" && f.budgetName.endsWith("-p95"));
  assert.ok(loginP95);
  assert.equal(loginP95.overBudget, true); // 650 > 500
  assert.equal(loginP95.tool, "k6");
});

test("parseK6Report: a FAILED k6 threshold marks the budget over even without a configured budget", () => {
  const parsed = parseK6Report(
    k6Summary(
      { http_req_duration: { "p(95)": 700 } },
      { http_req_duration: { ok: false } },
    ),
  );
  const f = parsed.findings.find((x) => x.budgetName.endsWith("-p95"));
  assert.equal(f.overBudget, true);
});

test("parsePerfReport: auto-detects the shape across all three sub-tools", () => {
  assert.equal(parsePerfReport(sizeLimitReport([{ name: "a", size: 10, sizeLimit: 5 }])).findings[0].tool, "size-limit");
  assert.equal(parsePerfReport(lhciAssertions([{ auditId: "interactive", url: "/x", actual: 1, expected: 2, passed: true }])).findings[0].tool, "lighthouse");
  assert.equal(parsePerfReport(k6Summary({ http_req_duration: { "p(95)": 1 } })).findings[0].tool, "k6");
});

// ---------------------------------------------------------------------------
// 3. STABLE KEY: budget-name:target — measured/budget drift robust.
// ---------------------------------------------------------------------------
test("normalizeRoute: strips scheme+host, query-string, trailing slash", () => {
  assert.equal(normalizeRoute("https://example.com/home/?a=1#x"), "/home");
  assert.equal(normalizeRoute("http://h/"), "/");
  assert.equal(normalizeRoute("/login"), "/login");
});

test("stable key: perf identity = perf:<target>:<budget-name>::budget (reuses arch-checks key)", () => {
  // Same budget@target, measured/budget numbers differ => SAME key (churn-robust).
  const a = parseSizeLimitReport([{ name: "main", size: 300000, sizeLimit: 250000 }]).findings[0];
  const b = parseSizeLimitReport([{ name: "main", size: 999999, sizeLimit: 100000 }]).findings[0];
  assert.equal(stableFindingKey(a), stableFindingKey(b), "measured/budget drift must NOT change the key");
  assert.match(stableFindingKey(a), /^perf:size:main::budget$/);
  assert.equal(perfStableDetail(a), a.value);
});

test("stable key: DIFFERENT budget-name OR DIFFERENT target => DIFFERENT key", () => {
  const lh = parseLighthouseReport(
    lhciAssertions([
      { auditId: "largest-contentful-paint", url: "/a", actual: 1, expected: 2, passed: true },
      { auditId: "cumulative-layout-shift", url: "/a", actual: 1, expected: 2, passed: true },
      { auditId: "largest-contentful-paint", url: "/b", actual: 1, expected: 2, passed: true },
    ]),
  );
  const keys = new Set(lh.findings.map(stableFindingKey));
  assert.equal(keys.size, 3, "budget-name and target both participate in identity");
  // lcp:/route shape (the documented example).
  assert.ok([...keys].some((k) => k === "perf:/a:lcp::budget"));
});

// ---------------------------------------------------------------------------
// 4. THRESHOLD VERDICT (DEFAULT — budget max): over budget => fail, under => pass.
// ---------------------------------------------------------------------------
test("threshold (default): a budget OVER its max => fail", () => {
  const parsed = parseSizeLimitReport([{ name: "main", size: 300000, sizeLimit: 250000 }]);
  const c = classifyPerf({ parsed }); // mode defaults to threshold
  assert.equal(c.mode, "threshold");
  assert.equal(c.result, "fail");
  assert.equal(c.overBudget, 1);
});

test("threshold (default): all budgets within max => pass (warn-class informational findings)", () => {
  const parsed = parseSizeLimitReport([
    { name: "main", size: 100000, sizeLimit: 250000 },
    { name: "vendor", size: 50000, sizeLimit: 100000 },
  ]);
  const c = classifyPerf({ parsed, mode: "threshold" });
  assert.equal(c.result, "pass");
  assert.equal(c.overBudget, 0);
  assert.equal(c.totals.warn, 2);
});

// ---------------------------------------------------------------------------
// 5. RATCHET VERDICT (regression vs base, COORD-126 reuse): fail only on NEW.
// ---------------------------------------------------------------------------
test("ratchet: a budget that newly went OVER vs base => fail (regression)", () => {
  // base: only legacy 'main' is over budget.
  const base = parseSizeLimitReport([{ name: "main", size: 300000, sizeLimit: 250000 }]);
  // current: legacy 'main' still over (pre-existing) PLUS 'vendor' newly over.
  const current = parseSizeLimitReport([
    { name: "main", size: 310000, sizeLimit: 250000 },
    { name: "vendor", size: 150000, sizeLimit: 100000 },
  ]);
  const c = classifyPerf({ parsed: current, mode: "ratchet", baseFindings: base.findings });
  assert.equal(c.mode, "ratchet");
  assert.equal(c.result, "fail");
  assert.equal(c.newFindings, 1);
  assert.equal(c.preExistingFindings, 1);
});

test("ratchet: an EQUAL-or-better budget set vs base => pass (legacy over-budget is frictionless)", () => {
  const base = parseSizeLimitReport([{ name: "main", size: 300000, sizeLimit: 250000 }]);
  // current: same budget still over, just a different measured number (churn).
  const current = parseSizeLimitReport([{ name: "main", size: 305000, sizeLimit: 250000 }]);
  const c = classifyPerf({ parsed: current, mode: "ratchet", baseFindings: base.findings });
  assert.equal(c.result, "pass");
  assert.equal(c.newFindings, 0);
  assert.equal(c.preExistingFindings, 1);
});

// ---------------------------------------------------------------------------
// 6. TIMEOUT PATH — a hung tool is process-group SIGKILLed within the bound and
// the gate is SKIPPED (never hangs, never fails). FAST fake child.
// ---------------------------------------------------------------------------
function fakeHangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 717171;
  return child;
}

test("runPerfBounded: a hung tool is SIGKILLed (negative pid = process group) within the bound", async () => {
  const child = fakeHangingChild();
  const killed = [];
  const res = await runPerfBounded(
    { bin: "/x/lhci", tool: "lighthouse", repoRoot: "/x", timeoutMs: 20 },
    {
      spawn: () => child,
      kill: (target, sig) => { killed.push([target, sig]); child.emit("close", null); },
    },
  );
  assert.equal(res.timedOut, true);
  // COORD-129: the WHOLE process group is signaled via the NEGATIVE pid.
  assert.deepEqual(killed, [[-child.pid, "SIGKILL"]]);
});

test("runPerfGate: timeout path => result 'skip' (hung tool never fails the gate)", async () => {
  const child = fakeHangingChild();
  const res = await runPerfGate(
    { repoRoot: "/x", mode: "threshold", timeoutMs: 10 },
    {
      fileExists: () => false,
      lookPath: (n) => (n === "k6" ? "/usr/bin/k6" : null),
      env: { PATH: "/usr/bin", GATE_PERF_TOOL: "k6" },
      spawn: () => child,
      kill: () => child.emit("close", null),
      readReport: () => null,
    },
  );
  assert.equal(res.timedOut, true);
  assert.equal(res.classification.result, "skip");
  assert.match(res.summary, /skip/i);
});

// ---------------------------------------------------------------------------
// 7. END-TO-END with a FAKE tool + fixture report (no size-limit/lhci/k6 install).
// ---------------------------------------------------------------------------
test("runPerfGate: tool present + fixture size-limit JSON OVER budget => fail (threshold)", async () => {
  const child = fakeHangingChild();
  const report = sizeLimitReport([{ name: "main", size: 300000, sizeLimit: 250000 }]);
  const res = await runPerfGate(
    { repoRoot: "/x", mode: "threshold" },
    {
      fileExists: () => false,
      lookPath: (n) => (n === "size-limit" ? "/usr/bin/size-limit" : null),
      env: { PATH: "/usr/bin", GATE_PERF_TOOL: "size-limit" },
      spawn: () => { setImmediate(() => child.emit("close", 1)); return child; },
      readReport: () => JSON.stringify(report),
    },
  );
  assert.equal(res.ran, true);
  assert.equal(res.classification.result, "fail");
  assert.equal(res.classification.overBudget, 1);
});

test("runPerfGate: tool present + fixture UNDER budget => pass (threshold)", async () => {
  const child = fakeHangingChild();
  const report = sizeLimitReport([{ name: "main", size: 100000, sizeLimit: 250000 }]);
  const res = await runPerfGate(
    { repoRoot: "/x", mode: "threshold" },
    {
      fileExists: () => false,
      lookPath: (n) => (n === "size-limit" ? "/usr/bin/size-limit" : null),
      env: { PATH: "/usr/bin", GATE_PERF_TOOL: "size-limit" },
      spawn: () => { setImmediate(() => child.emit("close", 0)); return child; },
      readReport: () => JSON.stringify(report),
    },
  );
  assert.equal(res.classification.result, "pass");
  assert.notEqual(res.classification.result, "fail");
});

test("runPerfGate: tool ran but output unparseable => graceful skip (never fail)", async () => {
  const child = fakeHangingChild();
  const res = await runPerfGate(
    { repoRoot: "/x", mode: "threshold" },
    {
      fileExists: () => false,
      lookPath: (n) => (n === "size-limit" ? "/usr/bin/size-limit" : null),
      env: { PATH: "/usr/bin", GATE_PERF_TOOL: "size-limit" },
      spawn: () => { setImmediate(() => child.emit("close", 0)); return child; },
      readReport: () => "garbage-not-json",
    },
  );
  assert.equal(res.classification.result, "skip");
  assert.notEqual(res.classification.result, "fail");
});

// ---------------------------------------------------------------------------
// 8. BUDGET LOADING + summary helpers.
// ---------------------------------------------------------------------------
test("loadBudgets: reads a flat budget-name:target map; tolerant of a bad path", () => {
  const b = loadBudgets("/x/budgets.json", { readBudgets: () => '{"lcp:/home":2500,"bundle-main:size":250000}' });
  assert.equal(b["lcp:/home"], 2500);
  assert.equal(b["bundle-main:size"], 250000);
  assert.deepEqual(loadBudgets("/missing", { readBudgets: () => { throw new Error("nope"); } }), {});
  assert.deepEqual(loadBudgets(null), {});
});

test("slug + SUPPORTED_TOOLS sanity", () => {
  assert.equal(slug("Main Bundle!"), "main-bundle");
  assert.deepEqual(SUPPORTED_TOOLS, ["size-limit", "lighthouse", "k6"]);
});

test("formatPerfSummary: emits a grep-friendly one-liner usable as an artifact field", () => {
  const parsed = parseSizeLimitReport([{ name: "main", size: 100000, sizeLimit: 250000 }]);
  const s = formatPerfSummary(classifyPerf({ parsed, mode: "threshold" }));
  assert.match(s, /^perf: (pass|fail|warn|skip) mode=threshold/);
  // Embeddable as a JSON string value without breaking the artifact.
  assert.doesNotMatch(s, /[\n"]/);
});

// ---------------------------------------------------------------------------
// 9. The perf summary is a valid gate-artifact field shape.
// ---------------------------------------------------------------------------
test("gate artifact: the perf summary is schema-valid (round-trips as a complete-artifact field)", () => {
  const { validateGateArtifact } = require("./gate-artifact-schema.js");
  const parsed = parseSizeLimitReport([]);
  const summary = formatPerfSummary(classifyPerf({ parsed, mode: "threshold" }));
  const artifact = {
    lane: "full",
    commit: "abc123",
    result: "pass",
    duration_ms: 10,
    command_list: ["perf (performance budgets, opt-in, mode=threshold)"],
    coverage: null,
    coverage_skip_reason: "off lane",
    audit: null,
    audit_skip_reason: "no lockfile",
    artifact_paths: ["artifacts/gates/full.latest.json"],
    perf: summary, // the new field rides alongside the required fields
  };
  const v = validateGateArtifact(artifact);
  assert.equal(v.complete, true, `artifact must stay complete with the perf field: missing=${v.missing}`);
});
