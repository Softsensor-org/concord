"use strict";
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");

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

const { stableFindingKey } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/arch-checks.js"));

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

test("ratchet: pre-existing survivors ONLY => pass (legacy debt not punished)", (t) => {
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-cli-ratchet-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "node_modules", ".bin", "stryker");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "stryker.conf.json"), "{}");
  const reportPath = path.join(root, "current.json");
  const report = strykerReport({ "src/a.js": [{ mutator: "BooleanLiteral", status: "Survived" }] });
  fs.writeFileSync(reportPath, JSON.stringify(report));
  const basePath = path.join(root, "base.json");
  fs.writeFileSync(basePath, JSON.stringify(report));
  const spawnSync = require("node:child_process").spawnSync;
  const run = (baseline) => spawnSync(process.execPath, [
    path.join(__dirname, "mutation-policy.js"), "classify", "--root", root, "--mode", "ratchet",
    "--report", reportPath, "--base-report", baseline,
  ], { encoding: "utf8" });
  const inherited = run(basePath);
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.match(inherited.stdout, /new=0 pre-existing=1/);
  fs.writeFileSync(basePath, "invalid mutation report");
  for (const baseline of [basePath, path.join(root, "missing.json")]) {
    const result = run(baseline);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /new=1 pre-existing=0/);
  }
});

// ---------------------------------------------------------------------------
// 5. TIMEOUT PATH — proves a hung tool is process-group SIGKILLed within the
// bound and the gate is SKIPPED (never hangs, never fails). FAST fake child.
// ---------------------------------------------------------------------------
function fakeHangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 717171;
  // COORD-701: hold the event loop open the way a REAL child does.
  //
  // The bounded runner deliberately unrefs its timeout timer — a hung tool must
  // not keep the gate process alive — and relies on the spawned child's own
  // handles to keep the loop running until the bound elapses. This fake is a
  // bare EventEmitter with no handles at all, so on Node 22 the loop drains
  // before the unref'd timer fires and the test runner reports "Promise
  // resolution is still pending but the event loop has already resolved",
  // which CANCELS every remaining test in the file. Node 25 happens to keep the
  // loop alive long enough, which is why this was invisible there.
  //
  // The keep-alive is self-terminating: it clears on close, and gives up after
  // ~1s regardless, so a test that never closes the child cannot hang the file.
  let ticks = 0;
  const keepAlive = setInterval(() => {
    if (++ticks > 200) clearInterval(keepAlive);
  }, 5);
  child.on("close", () => clearInterval(keepAlive));
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
  const { validateGateArtifact } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gate-artifact-schema.js"));
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

// Run as a script, the code runCli resolves must become the process exit
// status: a caller that shells out cannot observe a resolved promise.
test("CLI entrypoint: a usage error exits 2 with the reason on stderr and nothing on stdout", () => {
  const { spawnSync } = require("child_process");
  const cli = path.join(__dirname, "mutation-policy.js");

  const noVerb = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.equal(noVerb.status, 2);
  assert.match(noVerb.stderr, /^usage: mutation-policy\.js classify --root <repo> \[--mode threshold\|ratchet\]/);
  assert.equal(noVerb.stdout, "");

  const noRoot = spawnSync(process.execPath, [cli, "classify", "--mode", "ratchet"], { encoding: "utf8" });
  assert.equal(noRoot.status, 2);
  assert.equal(noRoot.stderr, "mutation: ERROR --root <repo> is required\n");
  assert.equal(noRoot.stdout, "");
});

test("threshold skips an otherwise valid report containing only ignored mutants", () => {
  const parsed = parseMutationReport(strykerReport({ "src/a.js": [{ mutator: "M", status: "Ignored" }] }));
  const classification = classifyMutation({ parsed, mode: "threshold", min: 80 });
  assert.equal(classification.result, "skip");
  assert.equal(classification.score, null);
  assert.equal(classification.available, false);
});

test("a successful tool exit without a report yields an unavailable score", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-missing-report-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = fakeHangingChild();
  const result = await runMutationGate({ repoRoot: root, reportPath: path.join(root, "missing.json") }, {
    fileExists: (p) => p.endsWith("stryker.conf.js") || p.endsWith(path.join(".bin", "stryker")),
    spawn: () => { setImmediate(() => child.emit("close", 0)); return child; },
  });
  assert.equal(result.classification.result, "skip");
  assert.equal(result.classification.available, false);
  assert.match(result.skipReason, /no parseable JSON report/);
});
