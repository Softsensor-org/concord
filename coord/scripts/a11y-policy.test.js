"use strict";

// COORD-134 (Quality dimension #4: Accessibility — pa11y/axe-core a11y scan +
// visual-regression). Tests for the EXTERNAL-tool-adapter. CRITICAL: this suite
// MUST NOT require pa11y/axe-core/playwright to be installed — every external
// interaction is a FAKE (injected spawn/kill/fileExists/lookPath/readReport) or a
// fixture a11y JSON / fixture snapshot-diff report. The engine keeps ZERO runtime
// deps and these tests prove the adapter is graceful when the tool is absent,
// correct when it ran, ratcheted vs a base, and bounded when it hangs.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const {
  DEFAULT_A11Y_THRESHOLD,
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
} = require("./a11y-policy.js");

const { stableFindingKey } = require("./arch-checks.js");

// ---------------------------------------------------------------------------
// Fixtures: a pa11y JSON report (issues[]) and an axe-core report (violations[]).
// ---------------------------------------------------------------------------
function pa11yReport(issues) {
  // pa11y --reporter json emits a top-level array of issue objects.
  return issues.map((i) => ({
    code: i.code,
    type: i.type || "error",
    selector: i.selector,
    context: i.context || "<a></a>",
    message: i.message || "issue",
    pageUrl: i.route,
  }));
}

function axeReport(violations, url) {
  return {
    url: url || "/dashboard",
    violations: violations.map((v) => ({
      id: v.id,
      impact: v.impact || "serious",
      help: v.message || "rule help",
      nodes: (v.selectors || ["body"]).map((sel) => ({ target: [sel], html: "<x/>" })),
    })),
  };
}

// ---------------------------------------------------------------------------
// 1. DETECTION + GRACEFUL SKIP — the #1 requirement: a missing tool NEVER fails.
// ---------------------------------------------------------------------------
test("detectTool: skips when no a11y runner is installed (tool unavailable)", () => {
  const d = detectTool("/repo", { fileExists: () => false, lookPath: () => null, env: {} });
  assert.equal(d.available, false);
  assert.match(d.reason, /no a11y runner installed/);
});

test("detectTool: available when pa11y resolves on PATH", () => {
  const d = detectTool("/repo", {
    fileExists: () => false,
    lookPath: (n) => (n === "pa11y" ? "/usr/bin/pa11y" : null),
    env: { PATH: "/usr/bin" },
  });
  assert.equal(d.available, true);
  assert.equal(d.tool, "pa11y");
  assert.equal(d.bin, "/usr/bin/pa11y");
});

test("detectTool: GATE_A11Y_RUNNER=axe forces axe ordering; AXE_BIN override wins", () => {
  const d = detectTool("/repo", {
    fileExists: (p) => p === "/opt/axe",
    lookPath: () => null,
    env: { GATE_A11Y_RUNNER: "axe", AXE_BIN: "/opt/axe" },
  });
  assert.equal(d.available, true);
  assert.equal(d.tool, "axe");
  assert.equal(d.bin, "/opt/axe");
});

test("runA11yGate: tool ABSENT => result 'skip', the gate is NOT failed (CLI exits 0)", async () => {
  const res = await runA11yGate(
    { repoRoot: "/repo", mode: "ratchet" },
    { fileExists: () => false, lookPath: () => null, env: {} },
  );
  assert.equal(res.ran, false);
  assert.equal(res.classification.result, "skip");
  assert.match(res.summary, /^a11y: skip/);
  assert.notEqual(res.classification.result, "fail");
});

test("runCli: missing tool exits 0 (a missing external tool MUST NOT fail the gate)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a11y-absent-"));
  const savedPath = process.env.PATH;
  const savedPa11y = process.env.PA11Y_BIN;
  const savedAxe = process.env.AXE_BIN;
  try {
    process.env.PATH = root; // a dir guaranteed to NOT contain pa11y/axe
    delete process.env.PA11Y_BIN;
    delete process.env.AXE_BIN;
    let out = "";
    const code = await runCli(
      ["classify", "--root", root, "--mode", "ratchet"],
      { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } },
    );
    assert.equal(code, 0, "missing tool must exit 0 (skip, never fail)");
    assert.match(out, /^a11y: skip/);
  } finally {
    process.env.PATH = savedPath;
    if (savedPa11y === undefined) delete process.env.PA11Y_BIN; else process.env.PA11Y_BIN = savedPa11y;
    if (savedAxe === undefined) delete process.env.AXE_BIN; else process.env.AXE_BIN = savedAxe;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. PARSE — pa11y + axe-core a11y JSON -> findings, with severity mapping.
// ---------------------------------------------------------------------------
test("parseA11yReport: returns null for empty/garbage input", () => {
  assert.equal(parseA11yReport(""), null);
  assert.equal(parseA11yReport("not json"), null);
  assert.equal(parseA11yReport({ no: "issues-or-violations" }), null);
});

test("parseA11yReport: an empty pa11y array yields zero findings (NOT null)", () => {
  const parsed = parseA11yReport([]);
  assert.notEqual(parsed, null);
  assert.equal(parsed.findings.length, 0);
  assert.equal(parsed.totals.total, 0);
});

test("parseA11yReport: pa11y issues -> findings; type error=>fail, warning=>warn", () => {
  const parsed = parseA11yReport(
    pa11yReport([
      { code: "WCAG2AA.1_4_3.G18", type: "error", selector: "#main > a", route: "/home", message: "contrast" },
      { code: "WCAG2AA.4_1_2.H91", type: "warning", selector: "button.x", route: "/home", message: "name" },
    ]),
  );
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.totals.fail, 1);
  assert.equal(parsed.totals.warn, 1);
  for (const f of parsed.findings) assert.equal(f.check, "a11y");
  assert.equal(parsed.findings[0].severity, "fail");
  assert.equal(parsed.findings[1].severity, "warn");
});

test("parseA11yReport: axe-core violations -> findings (one per node); critical/serious=>fail", () => {
  const parsed = parseA11yReport(
    axeReport(
      [
        { id: "color-contrast", impact: "serious", selectors: [".a", ".b"], message: "contrast" },
        { id: "label", impact: "moderate", selectors: ["input#q"], message: "label" },
      ],
      "/dashboard",
    ),
  );
  // 2 nodes for color-contrast + 1 for label = 3 findings.
  assert.equal(parsed.findings.length, 3);
  assert.equal(parsed.totals.fail, 2); // serious x2
  assert.equal(parsed.totals.warn, 1); // moderate
  assert.equal(parsed.findings[0].route, "/dashboard");
});

// ---------------------------------------------------------------------------
// 3. STABLE KEY: rule-id:selector-or-route — selector/index/churn robust.
// ---------------------------------------------------------------------------
test("normalizeSelector: strips volatile :nth-child / index / query-string detail", () => {
  const a = normalizeSelector("#list > li:nth-child(7) > a[3]");
  const b = normalizeSelector("#list > li:nth-child(99) > a[8]");
  assert.equal(a, b, "nth-child + index churn must normalize to the same selector");
  assert.equal(normalizeSelector("/users?id=5#frag"), normalizeSelector("/users?id=99"));
});

test("stable key: a11y identity = a11y:<route>:<rule-id>::<selector> (churn-robust, reuses arch-checks key)", () => {
  // Same rule, same route, selector differs only in nth-child index => same key.
  const a = parseA11yReport(
    pa11yReport([{ code: "WCAG2AA.1_4_3", type: "error", selector: "ul li:nth-child(2) a", route: "/p", message: "x" }]),
  ).findings[0];
  const b = parseA11yReport(
    pa11yReport([{ code: "WCAG2AA.1_4_3", type: "error", selector: "ul li:nth-child(40) a", route: "/p", message: "y" }]),
  ).findings[0];
  assert.equal(stableFindingKey(a), stableFindingKey(b), "selector index churn must NOT change the key");
  assert.match(stableFindingKey(a), /^a11y:\/p:WCAG2AA\.1_4_3::/);
  // a11yStableDetail mirrors what the arch-checks default branch produces.
  assert.equal(a11yStableDetail(a), a.value);
});

test("stable key: DIFFERENT rule id OR DIFFERENT route => DIFFERENT key (findings stay separable)", () => {
  const p = parseA11yReport(
    pa11yReport([
      { code: "rule.a", type: "error", selector: ".x", route: "/p", message: "m" },
      { code: "rule.b", type: "error", selector: ".x", route: "/p", message: "m" },
      { code: "rule.a", type: "error", selector: ".x", route: "/other", message: "m" },
    ]),
  );
  const keys = new Set(p.findings.map(stableFindingKey));
  assert.equal(keys.size, 3, "rule-id and route both participate in identity");
});

test("parseA11yReport: same rule+selector+route reported twice de-dups to one finding", () => {
  const parsed = parseA11yReport(
    pa11yReport([
      { code: "dup", type: "error", selector: ".same", route: "/p", message: "m1" },
      { code: "dup", type: "error", selector: ".same", route: "/p", message: "m2 churned" },
    ]),
  );
  assert.equal(parsed.findings.length, 1);
});

// ---------------------------------------------------------------------------
// 4. RATCHET VERDICT (DEFAULT, COORD-126 reuse): fail only on NEW violations.
// ---------------------------------------------------------------------------
test("ratchet (default): a NEW fail-class a11y violation vs baseline => fail", () => {
  const base = parseA11yReport(
    pa11yReport([{ code: "legacy", type: "error", selector: ".a", route: "/home", message: "legacy debt" }]),
  );
  const current = parseA11yReport(
    pa11yReport([
      { code: "legacy", type: "error", selector: ".a", route: "/home", message: "legacy debt" },
      { code: "new.rule", type: "error", selector: ".b", route: "/new", message: "newly introduced" },
    ]),
  );
  const c = classifyA11y({ parsed: current, baseFindings: base.findings }); // mode defaults to ratchet
  assert.equal(c.mode, "ratchet");
  assert.equal(c.result, "fail");
  assert.equal(c.newFindings, 1);
  assert.equal(c.preExistingFindings, 1);
});

test("ratchet (default): pre-existing violations ONLY => pass (legacy a11y debt is frictionless)", () => {
  const base = parseA11yReport(
    pa11yReport([
      { code: "legacy1", type: "error", selector: "ul li:nth-child(2) a", route: "/p", message: "x" },
      { code: "legacy2", type: "error", selector: ".btn", route: "/p", message: "y" },
    ]),
  );
  // current has the SAME two findings, just churned selector index + message.
  const current = parseA11yReport(
    pa11yReport([
      { code: "legacy1", type: "error", selector: "ul li:nth-child(88) a", route: "/p", message: "x2" },
      { code: "legacy2", type: "error", selector: ".btn", route: "/p", message: "y2" },
    ]),
  );
  const c = classifyA11y({ parsed: current, mode: "ratchet", baseFindings: base.findings });
  assert.equal(c.result, "pass");
  assert.equal(c.newFindings, 0);
  assert.equal(c.preExistingFindings, 2);
});

test("threshold mode (opt-in): a finding at/above the floor => fail; below => warn", () => {
  const parsedFail = parseA11yReport(pa11yReport([{ code: "r", type: "error", selector: ".a", route: "/p", message: "boom" }]));
  const cFail = classifyA11y({ parsed: parsedFail, mode: "threshold", threshold: "error" });
  assert.equal(cFail.result, "fail");
  assert.equal(cFail.threshold, DEFAULT_A11Y_THRESHOLD);

  const parsedWarn = parseA11yReport(pa11yReport([{ code: "r", type: "warning", selector: ".a", route: "/p", message: "soft" }]));
  const cWarn = classifyA11y({ parsed: parsedWarn, mode: "threshold", threshold: "error" });
  assert.equal(cWarn.result, "warn");
});

// ---------------------------------------------------------------------------
// 5. VISUAL REGRESSION — snapshot-diff report -> ratcheted route findings.
// ---------------------------------------------------------------------------
test("parseVisualRegressionReport: a diff beyond threshold => fail-class finding keyed by route", () => {
  const parsed = parseVisualRegressionReport({
    diffs: [
      { route: "/dashboard", diffRatio: 0.12 }, // changed beyond default threshold (0)
      { route: "/login", diffRatio: 0, status: "unchanged" }, // within threshold => warn
    ],
  });
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.totals.fail, 1);
  assert.equal(parsed.totals.warn, 1);
  const changed = parsed.findings.find((f) => f.severity === "fail");
  assert.equal(changed.ruleId, "visual-regression");
  assert.equal(changed.route, "/dashboard");
  assert.match(stableFindingKey(changed), /^a11y:\/dashboard:visual-regression::/);
});

test("visual-regression NEW diff vs base => fail; unchanged set vs base => pass (ratchet)", () => {
  const base = parseVisualRegressionReport({ diffs: [{ route: "/home", diffRatio: 0.2 }] });
  // current introduces a NEW changed route /checkout in addition to the legacy /home.
  const currentNew = parseVisualRegressionReport({
    diffs: [
      { route: "/home", diffRatio: 0.2 },
      { route: "/checkout", diffRatio: 0.3 },
    ],
  });
  const cNew = classifyA11y({ parsed: currentNew, mode: "ratchet", baseFindings: base.findings });
  assert.equal(cNew.result, "fail");
  assert.equal(cNew.newFindings, 1);

  // current with only the SAME route (different ratio — ratio is NOT part of the
  // identity) => no NEW finding => pass.
  const currentSame = parseVisualRegressionReport({ diffs: [{ route: "/home", diffRatio: 0.45 }] });
  const cSame = classifyA11y({ parsed: currentSame, mode: "ratchet", baseFindings: base.findings });
  assert.equal(cSame.result, "pass");
  assert.equal(cSame.newFindings, 0);
});

test("parseVisualRegressionReport: tolerant of misMatchPercentage + per-diff threshold", () => {
  const parsed = parseVisualRegressionReport({
    diffs: [
      { name: "/a", misMatchPercentage: 5, threshold: 0.1 }, // 0.05 <= 0.1 => warn
      { name: "/b", misMatchPercentage: 20, threshold: 0.1 }, // 0.20 > 0.1 => fail
    ],
  });
  assert.equal(parsed.totals.fail, 1);
  assert.equal(parsed.totals.warn, 1);
});

test("combineParsed: a11y scan findings + visual-regression findings ratchet together", () => {
  const a11y = parseA11yReport(pa11yReport([{ code: "r", type: "error", selector: ".a", route: "/p", message: "m" }]));
  const visual = parseVisualRegressionReport({ diffs: [{ route: "/p", diffRatio: 0.3 }] });
  const combined = combineParsed(a11y, visual);
  assert.equal(combined.findings.length, 2);
  assert.equal(combined.totals.fail, 2);
  assert.equal(combineParsed(null, null), null);
});

// ---------------------------------------------------------------------------
// 6. TIMEOUT PATH — proves a hung runner is process-group SIGKILLed within the
// bound and the gate is SKIPPED (never hangs, never fails). FAST fake child.
// ---------------------------------------------------------------------------
function fakeHangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 626262;
  return child;
}

test("runA11yBounded: a hung runner is SIGKILLed (negative pid = process group) within the bound", async () => {
  const child = fakeHangingChild();
  const killed = [];
  const res = await runA11yBounded(
    { bin: "/x/pa11y", tool: "pa11y", repoRoot: "/x", timeoutMs: 20 },
    {
      spawn: () => child,
      kill: (target, sig) => { killed.push([target, sig]); child.emit("close", null); },
    },
  );
  assert.equal(res.timedOut, true);
  // COORD-129: the WHOLE process group is signaled via the NEGATIVE pid.
  assert.deepEqual(killed, [[-child.pid, "SIGKILL"]]);
});

test("runA11yGate: timeout path => result 'skip' (hung runner never fails the gate)", async () => {
  const child = fakeHangingChild();
  const res = await runA11yGate(
    { repoRoot: "/x", mode: "ratchet", timeoutMs: 10 },
    {
      fileExists: () => false,
      lookPath: (n) => (n === "pa11y" ? "/usr/bin/pa11y" : null),
      env: { PATH: "/usr/bin" },
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
// 7. END-TO-END with a FAKE runner + fixture a11y JSON (no pa11y/axe install).
// ---------------------------------------------------------------------------
test("runA11yGate: tool present + fixture a11y JSON with a NEW finding vs base => fail (ratchet)", async () => {
  const child = fakeHangingChild();
  const base = parseA11yReport(pa11yReport([{ code: "legacy", type: "error", selector: ".a", route: "/p", message: "legacy" }]));
  const current = pa11yReport([
    { code: "legacy", type: "error", selector: ".a", route: "/p", message: "legacy" },
    { code: "new.rule", type: "error", selector: ".b", route: "/q", message: "new violation" },
  ]);
  const res = await runA11yGate(
    { repoRoot: "/x", mode: "ratchet", baseFindings: base.findings },
    {
      fileExists: () => false,
      lookPath: (n) => (n === "pa11y" ? "/usr/bin/pa11y" : null),
      env: { PATH: "/usr/bin" },
      spawn: () => { setImmediate(() => child.emit("close", 2)); return child; },
      readReport: () => JSON.stringify(current),
    },
  );
  assert.equal(res.ran, true);
  assert.equal(res.classification.result, "fail");
  assert.equal(res.classification.newFindings, 1);
});

test("runA11yGate: tool present + fixture a11y JSON with only pre-existing findings => pass (ratchet)", async () => {
  const child = fakeHangingChild();
  const base = parseA11yReport(pa11yReport([{ code: "legacy", type: "error", selector: "li:nth-child(2) a", route: "/p", message: "x" }]));
  const current = pa11yReport([{ code: "legacy", type: "error", selector: "li:nth-child(99) a", route: "/p", message: "x churned" }]);
  const res = await runA11yGate(
    { repoRoot: "/x", mode: "ratchet", baseFindings: base.findings },
    {
      fileExists: () => false,
      lookPath: (n) => (n === "pa11y" ? "/usr/bin/pa11y" : null),
      env: { PATH: "/usr/bin" },
      spawn: () => { setImmediate(() => child.emit("close", 0)); return child; },
      readReport: () => JSON.stringify(current),
    },
  );
  assert.equal(res.classification.result, "pass");
  assert.notEqual(res.classification.result, "fail");
});

test("runA11yGate: a11y runner absent but a visual-regression report supplied => ratchets visual alone", async () => {
  const base = parseVisualRegressionReport({ diffs: [{ route: "/home", diffRatio: 0.2 }] });
  const res = await runA11yGate(
    {
      repoRoot: "/x",
      mode: "ratchet",
      baseFindings: base.findings,
      visualReport: JSON.stringify({ diffs: [{ route: "/home", diffRatio: 0.2 }, { route: "/new", diffRatio: 0.4 }] }),
    },
    { fileExists: () => false, lookPath: () => null, env: {} }, // NO a11y runner
  );
  assert.equal(res.ran, true);
  assert.equal(res.tool, "visual-only");
  assert.equal(res.classification.result, "fail");
  assert.equal(res.classification.newFindings, 1);
});

test("runA11yGate: tool ran but output unparseable and no visual report => graceful skip (never fail)", async () => {
  const child = fakeHangingChild();
  const res = await runA11yGate(
    { repoRoot: "/x", mode: "ratchet" },
    {
      fileExists: () => false,
      lookPath: (n) => (n === "pa11y" ? "/usr/bin/pa11y" : null),
      env: { PATH: "/usr/bin" },
      spawn: () => { setImmediate(() => child.emit("close", 0)); return child; },
      readReport: () => "garbage-not-json",
    },
  );
  assert.equal(res.classification.result, "skip");
  assert.notEqual(res.classification.result, "fail");
});

// ---------------------------------------------------------------------------
// 8. The a11y summary is a valid gate-artifact field shape.
// ---------------------------------------------------------------------------
test("formatA11ySummary: emits a grep-friendly one-liner usable as an artifact field", () => {
  const parsed = parseA11yReport(pa11yReport([{ code: "r", type: "error", selector: ".a", route: "/p", message: "x" }]));
  const s = formatA11ySummary(classifyA11y({ parsed, mode: "ratchet", baseFindings: [] }));
  assert.match(s, /^a11y: (pass|fail|warn|skip) mode=ratchet/);
  // The whole string must be embeddable as a JSON string value without breaking
  // the artifact (no raw newlines/quotes injected by the formatter).
  assert.doesNotMatch(s, /[\n"]/);
});

test("gate artifact: the a11y summary is schema-valid (round-trips as a complete-artifact field)", () => {
  const { validateGateArtifact } = require("./gate-artifact-schema.js");
  const parsed = parseA11yReport([]);
  const summary = formatA11ySummary(classifyA11y({ parsed, mode: "ratchet", baseFindings: [] }));
  const artifact = {
    lane: "full",
    commit: "abc123",
    result: "pass",
    duration_ms: 10,
    command_list: ["a11y (accessibility, opt-in, mode=ratchet)"],
    coverage: null,
    coverage_skip_reason: "off lane",
    audit: null,
    audit_skip_reason: "no lockfile",
    artifact_paths: ["artifacts/gates/full.latest.json"],
    a11y: summary, // the new field rides alongside the required fields
  };
  const v = validateGateArtifact(artifact);
  assert.equal(v.complete, true, `artifact must stay complete with the a11y field: missing=${v.missing}`);
});
