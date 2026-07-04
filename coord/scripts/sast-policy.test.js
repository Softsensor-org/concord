"use strict";

// COORD-132 (Quality dimension #2: SAST — Semgrep static analysis). Tests for the
// EXTERNAL-tool-adapter. CRITICAL: this suite MUST NOT require Semgrep to be
// installed — every external interaction is a FAKE (injected
// spawn/kill/fileExists/lookPath/readReport) or a fixture SARIF payload. The
// engine keeps ZERO runtime deps and these tests prove the adapter is graceful
// when the tool is absent, correct when it ran, and bounded when it hangs.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const {
  DEFAULT_SAST_THRESHOLD,
  detectTool,
  normalizeMessage,
  parseSemgrepReport,
  sastStableDetail,
  classifySast,
  formatSastSummary,
  runSemgrepBounded,
  runSastGate,
  runCli,
} = require("./sast-policy.js");

const { stableFindingKey } = require("./arch-checks.js");

// ---------------------------------------------------------------------------
// Fixtures: a realistic Semgrep SARIF payload (SARIF 2.1.0 runs[].results shape).
// ---------------------------------------------------------------------------
function sarifReport(results) {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "semgrep" } },
        results: results.map((r) => ({
          ruleId: r.ruleId,
          level: r.level || "error",
          message: { text: r.message || "finding" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: r.file },
                region: { startLine: r.line || 1 },
              },
            },
          ],
        })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. DETECTION + GRACEFUL SKIP — the #1 requirement: a missing tool NEVER fails.
// ---------------------------------------------------------------------------
test("detectTool: skips when Semgrep binary is absent (tool unavailable)", () => {
  const d = detectTool("/repo", { fileExists: () => false, lookPath: () => null, env: {} });
  assert.equal(d.available, false);
  assert.match(d.reason, /not installed/);
});

test("detectTool: available when semgrep resolves on PATH", () => {
  const d = detectTool("/repo", {
    fileExists: () => false,
    lookPath: () => "/usr/bin/semgrep",
    env: { PATH: "/usr/bin" },
  });
  assert.equal(d.available, true);
  assert.equal(d.bin, "/usr/bin/semgrep");
});

test("detectTool: SEMGREP_BIN override wins when it exists", () => {
  const d = detectTool("/repo", {
    fileExists: (p) => p === "/opt/semgrep",
    lookPath: () => null,
    env: { SEMGREP_BIN: "/opt/semgrep" },
  });
  assert.equal(d.available, true);
  assert.equal(d.bin, "/opt/semgrep");
});

test("runSastGate: tool ABSENT => result 'skip', the gate is NOT failed (CLI exits 0)", async () => {
  const res = await runSastGate(
    { repoRoot: "/repo", mode: "ratchet" },
    { fileExists: () => false, lookPath: () => null, env: {} },
  );
  assert.equal(res.ran, false);
  assert.equal(res.classification.result, "skip");
  assert.match(res.summary, /^sast: skip/);
  // A skip must never be a fail — the CLI maps only "fail" to a non-zero code.
  assert.notEqual(res.classification.result, "fail");
});

test("runCli: missing tool exits 0 (a missing external tool MUST NOT fail the gate)", async () => {
  // Point --root at an empty temp dir with a PATH that has no semgrep => skip.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sast-absent-"));
  const savedPath = process.env.PATH;
  const savedBin = process.env.SEMGREP_BIN;
  try {
    process.env.PATH = root; // a dir guaranteed to NOT contain semgrep
    delete process.env.SEMGREP_BIN;
    let out = "";
    const code = await runCli(
      ["classify", "--root", root, "--mode", "ratchet"],
      { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } },
    );
    assert.equal(code, 0, "missing tool must exit 0 (skip, never fail)");
    assert.match(out, /^sast: skip/);
  } finally {
    process.env.PATH = savedPath;
    if (savedBin === undefined) delete process.env.SEMGREP_BIN;
    else process.env.SEMGREP_BIN = savedBin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. PARSE — Semgrep SARIF -> findings, with severity mapping.
// ---------------------------------------------------------------------------
test("parseSemgrepReport: returns null for empty/garbage input", () => {
  assert.equal(parseSemgrepReport(""), null);
  assert.equal(parseSemgrepReport("not json"), null);
  assert.equal(parseSemgrepReport({ no: "runs-or-results" }), null);
});

test("parseSemgrepReport: an empty-but-valid SARIF run yields zero findings (NOT null)", () => {
  const parsed = parseSemgrepReport(sarifReport([]));
  assert.notEqual(parsed, null);
  assert.equal(parsed.findings.length, 0);
  assert.equal(parsed.totals.total, 0);
});

test("parseSemgrepReport: emits one finding per result and maps ERROR=>fail, WARNING=>warn", () => {
  const parsed = parseSemgrepReport(
    sarifReport([
      { ruleId: "js.lang.security.detect-eval", level: "error", file: "src/a.js", line: 7, message: "Detected eval" },
      { ruleId: "js.lang.audit.weak-hash", level: "warning", file: "src/b.js", line: 3, message: "Weak hash" },
    ]),
  );
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.totals.fail, 1);
  assert.equal(parsed.totals.warn, 1);
  for (const f of parsed.findings) assert.equal(f.check, "sast");
  assert.equal(parsed.findings[0].severity, "fail");
  assert.equal(parsed.findings[1].severity, "warn");
});

test("parseSemgrepReport: parses the legacy top-level results[] (semgrep --json) shape", () => {
  const legacy = {
    results: [
      { check_id: "py.taint.sqli", path: "app/db.py", start: { line: 12 }, extra: { message: "SQLi", severity: "ERROR" } },
    ],
  };
  const parsed = parseSemgrepReport(legacy);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].ruleId, "py.taint.sqli");
  assert.equal(parsed.findings[0].file, "app/db.py");
  assert.equal(parsed.findings[0].severity, "fail");
});

// ---------------------------------------------------------------------------
// 3. STABLE KEY: rule-id:file:normalized-message — line/instance-detail robust.
// ---------------------------------------------------------------------------
test("normalizeMessage: strips volatile per-instance detail (line/col, snippets, numbers)", () => {
  const a = normalizeMessage("Tainted variable `userInput` flows to sink at line 42");
  const b = normalizeMessage("Tainted variable `req.body.name` flows to sink at line 88");
  // The quoted variable + the line number are the only differences => same norm.
  assert.equal(a, b);
});

test("stable key: SAST identity = sast:<file>:<rule-id>::<normalized-message> (churn-robust, reuses arch-checks key)", () => {
  // Two firings of the SAME rule in the SAME file whose message differs only in
  // volatile per-instance detail (variable name + line) AND sit on different
  // lines must collapse to the SAME stable key.
  const parsedA = parseSemgrepReport(
    sarifReport([{ ruleId: "js.detect-eval", level: "error", file: "src/a.js", line: 7, message: "eval of `x` at line 7" }]),
  );
  const parsedB = parseSemgrepReport(
    sarifReport([{ ruleId: "js.detect-eval", level: "error", file: "src/a.js", line: 200, message: "eval of `payload` at line 200" }]),
  );
  const fA = parsedA.findings[0];
  const fB = parsedB.findings[0];
  assert.equal(stableFindingKey(fA), stableFindingKey(fB), "churned message detail + line shift must NOT change the key");
  assert.match(stableFindingKey(fA), /^sast:src\/a\.js:js\.detect-eval::/);
  // sastStableDetail mirrors what the arch-checks default branch produces.
  assert.equal(sastStableDetail(fA), fA.value);
});

test("stable key: DIFFERENT rule id => DIFFERENT key (distinct findings stay separable)", () => {
  const p = parseSemgrepReport(
    sarifReport([
      { ruleId: "rule.a", level: "error", file: "src/x.js", line: 1, message: "same text" },
      { ruleId: "rule.b", level: "error", file: "src/x.js", line: 1, message: "same text" },
    ]),
  );
  assert.notEqual(stableFindingKey(p.findings[0]), stableFindingKey(p.findings[1]));
});

// ---------------------------------------------------------------------------
// 4. RATCHET VERDICT (DEFAULT, COORD-126 reuse): fail only on NEW findings.
// ---------------------------------------------------------------------------
test("ratchet (default): a NEW fail-class finding vs baseline => fail", () => {
  const base = parseSemgrepReport(
    sarifReport([{ ruleId: "rule.legacy", level: "error", file: "src/a.js", line: 5, message: "legacy debt" }]),
  );
  const current = parseSemgrepReport(
    sarifReport([
      { ruleId: "rule.legacy", level: "error", file: "src/a.js", line: 5, message: "legacy debt" },
      { ruleId: "rule.new", level: "error", file: "src/b.js", line: 20, message: "newly introduced injection" },
    ]),
  );
  const c = classifySast({ parsed: current, baseFindings: base.findings }); // mode defaults to ratchet
  assert.equal(c.mode, "ratchet");
  assert.equal(c.result, "fail");
  assert.equal(c.newFindings, 1);
  assert.equal(c.preExistingFindings, 1);
});

test("ratchet (default): pre-existing findings ONLY => pass (legacy debt is frictionless)", () => {
  const base = parseSemgrepReport(
    sarifReport([
      { ruleId: "rule.legacy1", level: "error", file: "src/a.js", line: 5, message: "tainted `a` at line 5" },
      { ruleId: "rule.legacy2", level: "error", file: "src/a.js", line: 20, message: "unsafe `b` at line 20" },
    ]),
  );
  // current has the SAME two findings, just churned lines + per-instance detail
  // (the quoted variable + the line number) — both stripped by normalizeMessage.
  const current = parseSemgrepReport(
    sarifReport([
      { ruleId: "rule.legacy1", level: "error", file: "src/a.js", line: 88, message: "tainted `xyz` at line 88" },
      { ruleId: "rule.legacy2", level: "error", file: "src/a.js", line: 120, message: "unsafe `qq` at line 120" },
    ]),
  );
  const c = classifySast({ parsed: current, mode: "ratchet", baseFindings: base.findings });
  assert.equal(c.result, "pass");
  assert.equal(c.newFindings, 0);
  assert.equal(c.preExistingFindings, 2);
});

test("threshold mode (opt-in): a finding at/above the floor => fail; below => warn/pass", () => {
  const parsedFail = parseSemgrepReport(
    sarifReport([{ ruleId: "r", level: "error", file: "a.js", message: "boom" }]),
  );
  const cFail = classifySast({ parsed: parsedFail, mode: "threshold", threshold: "error" });
  assert.equal(cFail.result, "fail");
  assert.equal(cFail.threshold, DEFAULT_SAST_THRESHOLD);

  const parsedWarn = parseSemgrepReport(
    sarifReport([{ ruleId: "r", level: "warning", file: "a.js", message: "soft" }]),
  );
  const cWarn = classifySast({ parsed: parsedWarn, mode: "threshold", threshold: "error" });
  assert.equal(cWarn.result, "warn");
});

// ---------------------------------------------------------------------------
// 5. TIMEOUT PATH — proves a hung tool is process-group SIGKILLed within the
// bound and the gate is SKIPPED (never hangs, never fails). FAST fake child.
// ---------------------------------------------------------------------------
function fakeHangingChild() {
  // A child that never emits "close" — simulates a hung Semgrep holding pipes.
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 525252;
  return child;
}

test("runSemgrepBounded: a hung tool is SIGKILLed (negative pid = process group) within the bound", async () => {
  const child = fakeHangingChild();
  const killed = [];
  const res = await runSemgrepBounded(
    { bin: "/x/semgrep", repoRoot: "/x", timeoutMs: 20 },
    {
      spawn: () => child,
      kill: (target, sig) => { killed.push([target, sig]); child.emit("close", null); },
    },
  );
  assert.equal(res.timedOut, true);
  // COORD-129: the WHOLE process group is signaled via the NEGATIVE pid.
  assert.deepEqual(killed, [[-child.pid, "SIGKILL"]]);
});

test("runSastGate: timeout path => result 'skip' (hung tool never fails the gate)", async () => {
  const child = fakeHangingChild();
  const res = await runSastGate(
    { repoRoot: "/x", mode: "ratchet", timeoutMs: 10 },
    {
      fileExists: () => false,
      lookPath: () => "/usr/bin/semgrep",
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
// 6. END-TO-END with a FAKE tool runner + fixture SARIF (no Semgrep install).
// ---------------------------------------------------------------------------
test("runSastGate: tool present + fixture SARIF with a NEW finding vs base => fail (ratchet)", async () => {
  const child = fakeHangingChild();
  const base = parseSemgrepReport(
    sarifReport([{ ruleId: "rule.legacy", level: "error", file: "src/a.js", line: 5, message: "legacy" }]),
  );
  const current = sarifReport([
    { ruleId: "rule.legacy", level: "error", file: "src/a.js", line: 5, message: "legacy" },
    { ruleId: "rule.new", level: "error", file: "src/b.js", line: 9, message: "new injection" },
  ]);
  const res = await runSastGate(
    { repoRoot: "/x", mode: "ratchet", baseFindings: base.findings },
    {
      fileExists: () => false,
      lookPath: () => "/usr/bin/semgrep",
      env: { PATH: "/usr/bin" },
      spawn: () => { setImmediate(() => child.emit("close", 1)); return child; },
      readReport: () => JSON.stringify(current),
    },
  );
  assert.equal(res.ran, true);
  assert.equal(res.classification.result, "fail");
  assert.equal(res.classification.newFindings, 1);
});

test("runSastGate: tool present + fixture SARIF with only pre-existing findings => pass (ratchet)", async () => {
  const child = fakeHangingChild();
  const base = parseSemgrepReport(
    sarifReport([{ ruleId: "rule.legacy", level: "error", file: "src/a.js", line: 5, message: "tainted `a` at line 5" }]),
  );
  const current = sarifReport([{ ruleId: "rule.legacy", level: "error", file: "src/a.js", line: 77, message: "tainted `z` at line 77" }]);
  const res = await runSastGate(
    { repoRoot: "/x", mode: "ratchet", baseFindings: base.findings },
    {
      fileExists: () => false,
      lookPath: () => "/usr/bin/semgrep",
      env: { PATH: "/usr/bin" },
      spawn: () => { setImmediate(() => child.emit("close", 0)); return child; },
      readReport: () => JSON.stringify(current),
    },
  );
  assert.equal(res.classification.result, "pass");
  assert.notEqual(res.classification.result, "fail");
});

test("runSastGate: tool ran but output unparseable => graceful skip (never fail)", async () => {
  const child = fakeHangingChild();
  const res = await runSastGate(
    { repoRoot: "/x", mode: "ratchet" },
    {
      fileExists: () => false,
      lookPath: () => "/usr/bin/semgrep",
      env: { PATH: "/usr/bin" },
      spawn: () => { setImmediate(() => child.emit("close", 0)); return child; },
      readReport: () => "garbage-not-json",
    },
  );
  assert.equal(res.classification.result, "skip");
  assert.notEqual(res.classification.result, "fail");
});

// ---------------------------------------------------------------------------
// 7. The SAST summary is a valid gate-artifact field shape.
// ---------------------------------------------------------------------------
test("formatSastSummary: emits a grep-friendly one-liner usable as an artifact field", () => {
  const parsed = parseSemgrepReport(
    sarifReport([{ ruleId: "r", level: "error", file: "a.js", message: "x" }]),
  );
  const s = formatSastSummary(classifySast({ parsed, mode: "ratchet", baseFindings: [] }));
  assert.match(s, /^sast: (pass|fail|warn|skip) mode=ratchet/);
  // The whole string must be embeddable as a JSON string value without breaking
  // the artifact (no raw newlines/quotes injected by the formatter).
  assert.doesNotMatch(s, /[\n"]/);
});

test("gate artifact: the sast summary is schema-valid (round-trips as a complete-artifact field)", () => {
  const { validateGateArtifact } = require("./gate-artifact-schema.js");
  const parsed = parseSemgrepReport(sarifReport([]));
  const summary = formatSastSummary(classifySast({ parsed, mode: "ratchet", baseFindings: [] }));
  const artifact = {
    lane: "full",
    commit: "abc123",
    result: "pass",
    duration_ms: 10,
    command_list: ["SAST (semgrep, opt-in, mode=ratchet)"],
    coverage: null,
    coverage_skip_reason: "off lane",
    audit: null,
    audit_skip_reason: "no lockfile",
    artifact_paths: ["artifacts/gates/full.latest.json"],
    sast: summary, // the new field rides alongside the required fields
  };
  const v = validateGateArtifact(artifact);
  assert.equal(v.complete, true, `artifact must stay complete with the sast field: missing=${v.missing}`);
});
