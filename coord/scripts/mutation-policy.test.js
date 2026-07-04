"use strict";

// COORD-131 (Quality dimension #1: Correctness — mutation + property-based
// testing). Tests for the EXTERNAL-tool-adapter. CRITICAL: this suite MUST NOT
// require Stryker/fast-check to be installed — every external interaction is a
// FAKE (injected spawn/kill/fileExists/readReport) or a fixture report. The
// engine keeps ZERO runtime deps and these tests prove the adapter is graceful
// when the tool is absent, correct when it ran, and bounded when it hangs.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const {
  DEFAULT_MUTATION_MIN,
  detectTool,
  parseMutationReport,
  mutationStableDetail,
  classifyMutation,
  formatMutationSummary,
  runStrykerBounded,
  runMutationGate,
  runCli,
} = require("./mutation-policy.js");

const { stableFindingKey } = require("./arch-checks.js");

// ---------------------------------------------------------------------------
// Fixtures: a realistic Stryker JSON report (mutation-report schema v1 shape).
// ---------------------------------------------------------------------------
function strykerReport(mutantsByFile) {
  const files = {};
  for (const [file, mutants] of Object.entries(mutantsByFile)) {
    files[file] = {
      language: "javascript",
      source: "// source",
      mutants: mutants.map((m, i) => ({
        id: `${file}#${i}`,
        mutatorName: m.mutator,
        status: m.status,
        location: { start: { line: m.line || 1, column: 1 }, end: { line: m.line || 1, column: 9 } },
      })),
    };
  }
  return { schemaVersion: "1", thresholds: { high: 80, low: 60 }, files };
}

// ---------------------------------------------------------------------------
// 1. DETECTION + GRACEFUL SKIP — the #1 requirement: a missing tool NEVER fails.
// ---------------------------------------------------------------------------
test("detectTool: skips when no Stryker config is present (dimension not configured)", () => {
  const d = detectTool("/repo", { fileExists: () => false });
  assert.equal(d.available, false);
  assert.match(d.reason, /not configured/);
});

test("detectTool: skips when config present but Stryker binary absent (tool unavailable)", () => {
  const d = detectTool("/repo", {
    fileExists: (p) => p.endsWith("stryker.conf.js"), // config yes, bin no
  });
  assert.equal(d.available, false);
  assert.match(d.reason, /not installed/);
});

test("detectTool: available only when BOTH config and binary resolve", () => {
  const d = detectTool("/repo", {
    fileExists: (p) => p.endsWith("stryker.conf.js") || p.endsWith(path.join("node_modules", ".bin", "stryker")),
  });
  assert.equal(d.available, true);
  assert.equal(d.reason, null);
});

test("runMutationGate: tool ABSENT => result 'skip', the gate is NOT failed (CLI exits 0)", async () => {
  const res = await runMutationGate(
    { repoRoot: "/repo", mode: "threshold", min: 100 },
    { fileExists: () => false },
  );
  assert.equal(res.ran, false);
  assert.equal(res.classification.result, "skip");
  assert.match(res.summary, /^mutation: skip/);
  // A skip must never be a fail — the CLI maps only "fail" to a non-zero code.
  assert.notEqual(res.classification.result, "fail");
});

test("runCli: missing tool exits 0 (a missing external tool MUST NOT fail the gate)", async () => {
  // Point --root at an empty temp dir: no stryker config, no binary => skip.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mut-absent-"));
  try {
    let out = "";
    const code = await runCli(
      ["classify", "--root", root, "--mode", "threshold", "--min", "100"],
      { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } },
    );
    assert.equal(code, 0, "missing tool must exit 0 (skip, never fail)");
    assert.match(out, /^mutation: skip/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. PARSE — Stryker report -> findings + score.
// ---------------------------------------------------------------------------
test("parseMutationReport: returns null for empty/garbage input", () => {
  assert.equal(parseMutationReport(""), null);
  assert.equal(parseMutationReport("not json"), null);
  assert.equal(parseMutationReport({ no: "files" }), null);
});

test("parseMutationReport: computes score and emits one finding per survived mutant", () => {
  const report = strykerReport({
    "src/a.js": [
      { mutator: "ArithmeticOperator", status: "Killed", line: 3 },
      { mutator: "BooleanLiteral", status: "Survived", line: 7 },
      { mutator: "ConditionalExpression", status: "NoCoverage", line: 9 },
      { mutator: "EqualityOperator", status: "Timeout", line: 11 }, // counts as killed
      { mutator: "StringLiteral", status: "Ignored", line: 13 }, // excluded from score
    ],
  });
  const parsed = parseMutationReport(report);
  // total excludes Ignored => 4; killed = Killed + Timeout = 2; score = 50%.
  assert.equal(parsed.totals.total, 4);
  assert.equal(parsed.totals.killed, 2);
  assert.equal(parsed.score, 50);
  // findings = Survived + NoCoverage = 2.
  assert.equal(parsed.findings.length, 2);
  for (const f of parsed.findings) {
    assert.equal(f.check, "mutation");
    assert.equal(f.severity, "fail");
  }
});

test("stable key: survived-mutant identity = mutation:<file>:<mutator> (line-shift robust, reuses arch-checks key)", () => {
  const f1 = { check: "mutation", file: "src/a.js", value: "BooleanLiteral", line: 7, severity: "fail" };
  const f2 = { check: "mutation", file: "src/a.js", value: "BooleanLiteral", line: 99, severity: "fail" };
  // The arch-checks default-branch key uses String(value); line is omitted, so a
  // pure line shift does NOT mint a new key (ratchet-robust).
  assert.equal(stableFindingKey(f1), stableFindingKey(f2));
  assert.equal(stableFindingKey(f1), "mutation:src/a.js:BooleanLiteral");
  assert.equal(mutationStableDetail(f1), "mut:BooleanLiteral");
});

// ---------------------------------------------------------------------------
// 3. THRESHOLD VERDICT.
// ---------------------------------------------------------------------------
test("threshold: below min => fail", () => {
  const parsed = parseMutationReport(
    strykerReport({ "src/a.js": [
      { mutator: "M", status: "Killed" }, { mutator: "M", status: "Survived" },
    ] }),
  ); // score = 50%
  const c = classifyMutation({ parsed, mode: "threshold", min: 60 });
  assert.equal(c.result, "fail");
  assert.equal(c.score, 50);
});

test("threshold: at/above min => pass", () => {
  const parsed = parseMutationReport(
    strykerReport({ "src/a.js": [
      { mutator: "M", status: "Killed" }, { mutator: "M", status: "Killed" },
      { mutator: "M", status: "Survived" },
    ] }),
  ); // score = 66.66%
  const c = classifyMutation({ parsed, mode: "threshold", min: 60 });
  assert.equal(c.result, "pass");
});

test("threshold: default min is applied when none supplied", () => {
  // All killed => 100% >= default min.
  const parsed = parseMutationReport(strykerReport({ "src/a.js": [{ mutator: "M", status: "Killed" }] }));
  const c = classifyMutation({ parsed, mode: "threshold" });
  assert.equal(c.threshold, DEFAULT_MUTATION_MIN);
  assert.equal(c.result, "pass");
});

// ---------------------------------------------------------------------------
// 4. RATCHET VERDICT (COORD-126 reuse): fail only on NEW survived mutants.
// ---------------------------------------------------------------------------
test("ratchet: a NEW survived mutant vs baseline => fail", () => {
  // base had 1 survivor (BooleanLiteral); current adds a NEW one (ArithmeticOperator).
  const base = parseMutationReport(
    strykerReport({ "src/a.js": [{ mutator: "BooleanLiteral", status: "Survived", line: 5 }] }),
  );
  const current = parseMutationReport(
    strykerReport({ "src/a.js": [
      { mutator: "BooleanLiteral", status: "Survived", line: 5 },
      { mutator: "ArithmeticOperator", status: "Survived", line: 20 },
    ] }),
  );
  const c = classifyMutation({ parsed: current, mode: "ratchet", baseFindings: base.findings });
  assert.equal(c.result, "fail");
  assert.equal(c.newSurvivors, 1);
  assert.equal(c.preExistingSurvivors, 1);
});

test("ratchet: pre-existing survivors ONLY => pass (legacy debt not punished)", () => {
  const base = parseMutationReport(
    strykerReport({ "src/a.js": [
      { mutator: "BooleanLiteral", status: "Survived", line: 5 },
      { mutator: "ArithmeticOperator", status: "Survived", line: 20 },
    ] }),
  );
  // current has the SAME two survivors, just shifted lines (churn) — still pre-existing.
  const current = parseMutationReport(
    strykerReport({ "src/a.js": [
      { mutator: "BooleanLiteral", status: "Survived", line: 88 },
      { mutator: "ArithmeticOperator", status: "Survived", line: 120 },
    ] }),
  );
  const c = classifyMutation({ parsed: current, mode: "ratchet", baseFindings: base.findings });
  assert.equal(c.result, "pass");
  assert.equal(c.newSurvivors, 0);
  assert.equal(c.preExistingSurvivors, 2);
});

// ---------------------------------------------------------------------------
// 5. TIMEOUT PATH — proves a hung tool is process-group SIGKILLed within the
// bound and the gate is SKIPPED (never hangs, never fails). FAST fake child.
// ---------------------------------------------------------------------------
function fakeHangingChild() {
  // A child that never emits "close" — simulates a hung Stryker holding pipes.
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 424242;
  return child;
}

test("runStrykerBounded: a hung tool is SIGKILLed (negative pid = process group) within the bound", async () => {
  const child = fakeHangingChild();
  const killed = [];
  const res = await runStrykerBounded(
    { bin: "/x/stryker", configPath: "/x/stryker.conf.js", repoRoot: "/x", reportPath: "/x/r.json", timeoutMs: 20 },
    {
      spawn: () => child,
      kill: (target, sig) => { killed.push([target, sig]); child.emit("close", null); },
    },
  );
  assert.equal(res.timedOut, true);
  // COORD-129: the WHOLE process group is signaled via the NEGATIVE pid.
  assert.deepEqual(killed, [[-child.pid, "SIGKILL"]]);
});

test("runMutationGate: timeout path => result 'skip' (hung tool never fails the gate)", async () => {
  const child = fakeHangingChild();
  const res = await runMutationGate(
    { repoRoot: "/x", mode: "threshold", min: 100, timeoutMs: 10, reportPath: "/x/r.json" },
    {
      fileExists: (p) => p.endsWith("stryker.conf.js") || p.endsWith(path.join(".bin", "stryker")),
      spawn: () => child,
      kill: () => child.emit("close", null),
      readReport: () => null,
    },
  );
  assert.equal(res.timedOut, true);
  assert.equal(res.classification.result, "skip");
  assert.match(res.summary, /COORD-129|SIGKILL|skip/i);
});

// ---------------------------------------------------------------------------
// 6. END-TO-END with a FAKE tool runner + fixture report (no Stryker install).
// ---------------------------------------------------------------------------
test("runMutationGate: tool present + fixture report below threshold => fail (CLI exit 1)", async () => {
  const child = fakeHangingChild();
  const report = strykerReport({ "src/a.js": [
    { mutator: "M", status: "Killed" }, { mutator: "M", status: "Survived" },
  ] }); // 50%
  const res = await runMutationGate(
    { repoRoot: "/x", mode: "threshold", min: 60, reportPath: "/x/r.json" },
    {
      fileExists: (p) => p.endsWith("stryker.conf.js") || p.endsWith(path.join(".bin", "stryker")),
      spawn: () => { setImmediate(() => child.emit("close", 0)); return child; },
      readReport: () => JSON.stringify(report),
    },
  );
  assert.equal(res.ran, true);
  assert.equal(res.classification.result, "fail");
});

test("runMutationGate: tool present + fixture report at/above threshold => pass", async () => {
  const child = fakeHangingChild();
  const report = strykerReport({ "src/a.js": [
    { mutator: "M", status: "Killed" }, { mutator: "M", status: "Killed" },
  ] }); // 100%
  const res = await runMutationGate(
    { repoRoot: "/x", mode: "threshold", min: 60, reportPath: "/x/r.json" },
    {
      fileExists: (p) => p.endsWith("stryker.conf.js") || p.endsWith(path.join(".bin", "stryker")),
      spawn: () => { setImmediate(() => child.emit("close", 0)); return child; },
      readReport: () => JSON.stringify(report),
    },
  );
  assert.equal(res.classification.result, "pass");
});

test("runMutationGate: tool ran but report unparseable => graceful skip (never fail)", async () => {
  const child = fakeHangingChild();
  const res = await runMutationGate(
    { repoRoot: "/x", reportPath: "/x/r.json" },
    {
      fileExists: (p) => p.endsWith("stryker.conf.js") || p.endsWith(path.join(".bin", "stryker")),
      spawn: () => { setImmediate(() => child.emit("close", 0)); return child; },
      readReport: () => "garbage-not-json",
    },
  );
  assert.equal(res.classification.result, "skip");
  assert.notEqual(res.classification.result, "fail");
});

// ---------------------------------------------------------------------------
// 7. The mutation summary is a valid gate-artifact field shape.
// ---------------------------------------------------------------------------
test("formatMutationSummary: emits a grep-friendly one-liner usable as an artifact field", () => {
  const parsed = parseMutationReport(strykerReport({ "src/a.js": [
    { mutator: "M", status: "Killed" }, { mutator: "M", status: "Survived" },
  ] }));
  const thr = classifyMutation({ parsed, mode: "threshold", min: 60 });
  const s = formatMutationSummary(thr);
  assert.match(s, /^mutation: (pass|fail|skip|warn) mode=threshold/);
  // The whole string must be embeddable as a JSON string value without breaking
  // the artifact (no raw newlines/quotes injected by the formatter).
  assert.doesNotMatch(s, /[\n"]/);
});

test("gate artifact: the mutation summary is schema-valid (round-trips as a complete-artifact field)", () => {
  const { validateGateArtifact } = require("./gate-artifact-schema.js");
  const parsed = parseMutationReport(strykerReport({ "src/a.js": [{ mutator: "M", status: "Killed" }] }));
  const summary = formatMutationSummary(classifyMutation({ parsed, mode: "threshold", min: 60 }));
  const artifact = {
    lane: "full",
    commit: "abc123",
    result: "pass",
    duration_ms: 10,
    command_list: ["correctness (mutation testing — stryker)"],
    coverage: null,
    coverage_skip_reason: "off lane",
    audit: null,
    audit_skip_reason: "no lockfile",
    artifact_paths: ["artifacts/gates/full.latest.json"],
    mutation: summary, // the new field rides alongside the required fields
  };
  const v = validateGateArtifact(artifact);
  assert.equal(v.complete, true, `artifact must stay complete with the mutation field: missing=${v.missing}`);
});
