"use strict";

// COORD-078 (QGATE-004): architecture/complexity guardrail tests.
// Pure-policy + lightweight static analysis + CLI behavior, plus template
// gate.sh runner integration. WARNING-FIRST is the load-bearing default.
// No board/runtime side effects (temp fixtures only).

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const arch = require("./arch-checks.js");
const {
  CHECKS,
  SEVERITIES,
  DEFAULT_CONFIG,
  mergeConfig,
  stripComments,
  countLoc,
  checkFileSize,
  estimateComplexity,
  extractFunctions,
  ownComplexity,
  checkComplexity,
  extractImports,
  checkImportBoundaries,
  checkDuplication,
  extractLiterals,
  checkHardcodedLiterals,
  checkRepeatedStrings,
  extractTopLevelDefs,
  buildReferenceIndex,
  checkDeadCode,
  runChecks,
  summarizeFindings,
  formatArchSummary,
  scanRepo,
  runCli,
} = arch;

const CLI = path.join(__dirname, "arch-checks.js");

function mkLines(n, makeLine = (i) => `const v${i} = fn(${i});`) {
  return Array.from({ length: n }, (_, i) => makeLine(i)).join("\n");
}

// --- config / constants ----------------------------------------------------

test("CHECKS and SEVERITIES expose the documented vocabulary", () => {
  assert.deepEqual(CHECKS, ["size", "complexity", "imports", "duplication", "monolith", "hardcoding", "deadcode"]);
  assert.deepEqual(SEVERITIES, ["off", "warn", "fail"]);
});

test("DEFAULT_CONFIG is WARNING-FIRST: every check defaults to warn", () => {
  for (const name of CHECKS) {
    assert.equal(DEFAULT_CONFIG.checks[name].severity, "warn", `${name} should default to warn`);
  }
});

test("mergeConfig overrides per-check fields without dropping defaults", () => {
  const cfg = mergeConfig({ checks: { size: { maxLoc: 10, severity: "fail" } } });
  assert.equal(cfg.checks.size.maxLoc, 10);
  assert.equal(cfg.checks.size.severity, "fail");
  // untouched checks keep their defaults
  assert.equal(cfg.checks.complexity.severity, "warn");
  assert.equal(cfg.checks.complexity.maxComplexity, DEFAULT_CONFIG.checks.complexity.maxComplexity);
});

// --- countLoc ---------------------------------------------------------------

test("countLoc strips comments and blank lines", () => {
  const src = "const a = 1;\n\n// a comment\n/* block\n multi */\nconst b = 2;\n";
  const { loc } = countLoc(src);
  assert.equal(loc, 2);
});

// COORD-094: countLoc / stripComments must NOT treat `/*` or `*/` appearing
// inside a string or regex literal as a block-comment marker. The old greedy
// `/\/\*[\s\S]*?\*\//g` swallowed real lines (it under-counted lifecycle.js by
// ~1600 LOC because of `endsWith("/*")`, `plans/*.json`, and `${id}/*`).
test("countLoc does not strip /* */ markers inside string and regex literals (COORD-094)", () => {
  const src = [
    'const a = "coord/.runtime/plans/*.json";', // /* inside a double-quoted string
    "const b = '/*';",                          // /* inside a single-quoted string
    "if (x.endsWith(\"/*\")) { doThing(); }",   // /* inside a string in real code
    "const re = /foo\\/\\*bar/;",               // /* inside a regex literal
    "const t = `${id}/*`;",                     // /* inside a template literal
    "const c = 3;",
  ].join("\n");
  // Every line is real code — none should be swallowed as a phantom comment.
  assert.equal(countLoc(src).loc, 6);
});

test("countLoc still strips genuine block comments spanning lines (COORD-094)", () => {
  const src = "const a = 1;\n/* a real\n   multi-line\n   comment */\nconst b = 2;\n";
  assert.equal(countLoc(src).loc, 2);
});

test("stripComments removes only genuine comments, preserving literal content", () => {
  const out = stripComments('const s = "a /* b */ c"; // tail\nconst d = 1; /* gone */ const e = 2;');
  assert.match(out, /"a \/\* b \*\/ c"/, "string literal with comment markers is preserved verbatim");
  assert.doesNotMatch(out, /tail/, "line comment is stripped");
  assert.doesNotMatch(out, /gone/, "block comment is stripped");
  assert.match(out, /const d = 1;/);
  assert.match(out, /const e = 2;/);
});

// --- size / monolith (no-new-monolith) -------------------------------------

test("size check flags a file over the LOC budget and passes a clean one", () => {
  const big = checkFileSize({ file: "big.js", source: mkLines(40), maxLoc: 10, severity: "warn" });
  assert.equal(big.length, 1);
  assert.equal(big[0].check, "size");
  assert.equal(big[0].file, "big.js");
  assert.ok(big[0].value > big[0].threshold);
  assert.equal(big[0].threshold, 10);
  assert.equal(big[0].severity, "warn");
  assert.match(big[0].message, /over budget/);

  const clean = checkFileSize({ file: "ok.js", source: mkLines(3), maxLoc: 10, severity: "warn" });
  assert.deepEqual(clean, []);
});

test("size check honors a justified per-file budget override (COORD-091)", () => {
  const perFile = { "lifecycle.js": 30 };
  // Basename-keyed: a path resolving to lifecycle.js uses the 30-line budget...
  const underOverride = checkFileSize({
    file: "coord/scripts/lifecycle.js",
    source: mkLines(20),
    maxLoc: 10,
    severity: "warn",
    perFile,
  });
  assert.deepEqual(underOverride, [], "file under its per-file budget is not flagged");

  // ...and only trips once it exceeds its OWN (higher) budget, reporting that
  // budget as the threshold — not the global one.
  const overOverride = checkFileSize({
    file: "coord/scripts/lifecycle.js",
    source: mkLines(40),
    maxLoc: 10,
    severity: "warn",
    perFile,
  });
  assert.equal(overOverride.length, 1);
  assert.equal(overOverride[0].threshold, 30, "finding reports the per-file budget, not the global one");
  assert.match(overOverride[0].message, /over budget 30/);

  // A non-overridden file still measures against the global budget.
  const other = checkFileSize({
    file: "coord/scripts/other.js",
    source: mkLines(20),
    maxLoc: 10,
    severity: "warn",
    perFile,
  });
  assert.equal(other.length, 1);
  assert.equal(other[0].threshold, 10);

  // The monolith check ignores perFile — the hard ceiling is not negotiable.
  const mono = checkFileSize({
    file: "coord/scripts/lifecycle.js",
    source: mkLines(40),
    maxLoc: 10,
    severity: "warn",
    checkName: "monolith",
    perFile,
  });
  assert.equal(mono.length, 1, "monolith budget is not overridden by perFile");
  assert.equal(mono[0].threshold, 10);
});

test("DEFAULT_CONFIG carries the lifecycle.js composition-root size override (COORD-091)", () => {
  assert.ok(DEFAULT_CONFIG.checks.size.perFile, "size check exposes a perFile override map");
  // COORD-094: bumped from 1750 -> 5000 after fixing countLoc's literal-blind
  // comment stripper revealed lifecycle.js's honest size (~4837 LOC, was being
  // under-counted to ~1682). 5000 sits just above the true size and at the
  // monolith hard ceiling, so genuine growth still trips a signal.
  assert.equal(DEFAULT_CONFIG.checks.size.perFile["lifecycle.js"], 5000);
  // mergeConfig preserves the default perFile map when an unrelated field is overridden.
  const merged = mergeConfig({ checks: { size: { severity: "fail" } } });
  assert.equal(merged.checks.size.perFile["lifecycle.js"], 5000);
});

test("monolith check reuses the size analyzer at a higher budget", () => {
  const r = runChecks({
    files: [{ file: "mono.js", source: mkLines(200) }],
    config: { checks: { monolith: { maxLoc: 50 }, size: { maxLoc: 50 } } },
  });
  const mono = r.findings.filter((f) => f.check === "monolith");
  assert.equal(mono.length, 1);
  assert.equal(mono[0].check, "monolith");
});

// --- complexity -------------------------------------------------------------

test("estimateComplexity counts decision points", () => {
  const fn = "function f(a){ if(a){} for(;;){} while(true){} return a && b || c ? 1 : 2; }";
  // base 1 + if + for + while + && + || + ?: => >= 6
  assert.ok(estimateComplexity(fn) >= 6, `expected >=6, got ${estimateComplexity(fn)}`);
  assert.equal(estimateComplexity("function g(){ return 1; }"), 1);
});

test("extractFunctions finds named functions with start lines", () => {
  const src = "const x = 1;\nfunction foo(a){\n return a;\n}\n";
  const fns = extractFunctions(src);
  assert.ok(fns.some((f) => f.name === "foo"));
});

// COORD-094: control-flow keywords lexically resemble `name(...) {` and were
// being captured as phantom "functions" (e.g. a finding for a function named
// `for` / `switch` / `if`), inflating both the per-function complexity value
// and the overall complexity finding COUNT. They must never appear as names.
test("extractFunctions does not treat control-flow keywords as function names (COORD-094)", () => {
  const src = [
    "function real(a) {",
    "  if (a) { doX(); }",
    "  for (let i = 0; i < 10; i += 1) { doY(); }",
    "  while (a) { doZ(); }",
    "  switch (a) { case 1: break; default: break; }",
    "}",
  ].join("\n");
  const fns = extractFunctions(src);
  const names = fns.map((f) => f.name);
  assert.ok(names.includes("real"), "the real function is found");
  for (const kw of ["if", "for", "while", "switch", "case", "catch", "default"]) {
    assert.ok(!names.includes(kw), `control-flow keyword "${kw}" must not be a function name`);
  }
});

// COORD-094: a function's reported complexity must be its OWN cyclomatic
// complexity — decision points in nested functions belong to the child, not the
// parent. Before the fix an outer factory summed every nested helper's
// complexity (mis-attributing the hotspot to the wiring root).
test("ownComplexity excludes decision points belonging to nested functions (COORD-094)", () => {
  const src = [
    "function outer(a) {",        // own decisions: 1 if  -> base 1 + 1 = 2
    "  if (a) { return 1; }",
    "  function inner(b) {",      // child carries its own 3 decisions
    "    if (b) {}",
    "    for (;;) {}",
    "    while (b) {}",
    "    return b;",
    "  }",
    "  return inner;",
    "}",
  ].join("\n");
  const fns = extractFunctions(src);
  const outer = fns.find((f) => f.name === "outer");
  const inner = fns.find((f) => f.name === "inner");
  assert.ok(outer && inner, "both functions extracted");
  // outer's OWN complexity counts only its own `if` (not inner's branches).
  assert.equal(ownComplexity(outer, fns), 2);
  // inner keeps its full complexity: base 1 + if + for + while = 4.
  assert.equal(ownComplexity(inner, fns), 4);
});

test("complexity check flags an over-budget function and passes a simple one", () => {
  const complex = "function big(a,b,c){ if(a){} if(b){} if(c){} for(;;){} while(1){} return a&&b||c; }";
  const hit = checkComplexity({ file: "c.js", source: complex, maxComplexity: 3, severity: "warn" });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].check, "complexity");
  assert.ok(hit[0].value > 3);
  assert.equal(hit[0].line, 1);

  const simple = checkComplexity({ file: "c.js", source: "function s(){ return 1; }", maxComplexity: 3, severity: "warn" });
  assert.deepEqual(simple, []);
});

// --- import boundaries ------------------------------------------------------

test("extractImports reads require() and import specifiers", () => {
  const src = "const a = require('../db/x');\nimport b from '../ui/y';\n";
  const specs = extractImports(src).map((s) => s.spec);
  assert.ok(specs.includes("../db/x"));
  assert.ok(specs.includes("../ui/y"));
});

test("import boundary check flags a disallowed import and passes when allowed", () => {
  const rules = [{ from: "src/ui/", denyImport: "db/", message: "ui must not import db" }];
  const bad = checkImportBoundaries({
    file: "src/ui/widget.js",
    source: "const x = require('../db/secret');",
    rules,
    severity: "fail",
  });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].check, "imports");
  assert.equal(bad[0].severity, "fail");
  assert.equal(bad[0].message, "ui must not import db");

  // a file outside the boundary `from` is unaffected
  const ok = checkImportBoundaries({
    file: "src/server/handler.js",
    source: "const x = require('../db/secret');",
    rules,
    severity: "fail",
  });
  assert.deepEqual(ok, []);

  // no rules => no findings (template default stays green)
  assert.deepEqual(checkImportBoundaries({ file: "any.js", source: "require('db/x')", rules: [], severity: "warn" }), []);
});

test("import boundary check supports RegExp denyImport", () => {
  const rules = [{ from: "src/", denyImport: /^lodash/, message: "no lodash" }];
  const bad = checkImportBoundaries({ file: "src/a.js", source: "require('lodash/merge')", rules, severity: "warn" });
  assert.equal(bad.length, 1);
});

test("import boundary check honors exceptFrom (sub-scope carve-out)", () => {
  // `from` matches the whole subtree but exceptFrom excludes a nested scope.
  const rules = [{ from: "pkg/", exceptFrom: "pkg/inner/", denyImport: "secret/", message: "no secret" }];
  // file in the excluded sub-scope is NOT subject to the rule
  assert.deepEqual(
    checkImportBoundaries({ file: "pkg/inner/a.js", source: "require('secret/x')", rules, severity: "warn" }),
    [],
  );
  // file in `from` but outside the carve-out IS subject to the rule
  const bad = checkImportBoundaries({ file: "pkg/a.js", source: "require('secret/x')", rules, severity: "warn" });
  assert.equal(bad.length, 1);
  // exceptFrom may be an array of carve-outs
  const rulesArr = [{ from: "pkg/", exceptFrom: ["pkg/inner/", "pkg/vendor/"], denyImport: "secret/", message: "no secret" }];
  assert.deepEqual(
    checkImportBoundaries({ file: "pkg/vendor/a.js", source: "require('secret/x')", rules: rulesArr, severity: "warn" }),
    [],
  );
});

// COORD-111: the open-core boundary rule shipped in DEFAULT_CONFIG must flag a
// (simulated) core->enterprise import and allow enterprise->core / enterprise
// sibling imports. This proves the gate catches a real boundary violation while
// staying 0 findings on the actual tree (which has no core->enterprise import).
test("COORD-111 open-core boundary: core->enterprise flagged, enterprise->core allowed", () => {
  const rules = DEFAULT_CONFIG.checks.imports.rules;
  // a CORE module reaching into the enterprise subtree -> FLAGGED
  const coreImportsEnt = checkImportBoundaries({
    file: "coord/scripts/cli.js",
    source: "const rbac = require('./enterprise/enterprise-rbac-policy.js');",
    rules,
    severity: "fail",
  });
  assert.equal(coreImportsEnt.length, 1, "core->enterprise import must be flagged");
  assert.equal(coreImportsEnt[0].check, "imports");
  assert.match(coreImportsEnt[0].message, /open-core boundary/);

  // a CORE module reaching enterprise via a relative climb -> FLAGGED
  const coreImportsEntRel = checkImportBoundaries({
    file: "coord/scripts/lifecycle.js",
    source: "const c = require('../scripts/enterprise/enterprise-broker-contract.js');",
    rules,
    severity: "fail",
  });
  assert.equal(coreImportsEntRel.length, 1, "core->enterprise (relative) import must be flagged");

  // an ENTERPRISE module importing CORE -> ALLOWED (enterprise may depend on core)
  const entImportsCore = checkImportBoundaries({
    file: "coord/scripts/enterprise/enterprise-broker-contract.js",
    source: "const id = require('../identity-v2.js'); const j = require('../journal.js');",
    rules,
    severity: "fail",
  });
  assert.deepEqual(entImportsCore, [], "enterprise->core import must be allowed");

  // an ENTERPRISE module importing an ENTERPRISE sibling -> ALLOWED (not self-flagged)
  const entImportsEntSibling = checkImportBoundaries({
    file: "coord/scripts/enterprise/enterprise-broker-contract.js",
    source: "const p = require('./enterprise-rbac-policy.js');",
    rules,
    severity: "fail",
  });
  assert.deepEqual(entImportsEntSibling, [], "enterprise->enterprise sibling import must be allowed");

  // a CORE module that does NOT touch enterprise -> ALLOWED
  const coreNeutral = checkImportBoundaries({
    file: "coord/scripts/cli.js",
    source: "const j = require('./journal.js');",
    rules,
    severity: "fail",
  });
  assert.deepEqual(coreNeutral, [], "core->core import must be allowed");
});

// --- duplication ------------------------------------------------------------

test("duplication check flags a repeated block across files as ONE collapsed finding", () => {
  const block = mkLines(30);
  const findings = checkDuplication({
    files: [{ file: "p.js", source: block }, { file: "q.js", source: block }],
    minLines: 12,
    severity: "warn",
  });
  assert.equal(findings.length, 1, "overlapping windows collapse to one region per occurrence");
  assert.equal(findings[0].check, "duplication");
  assert.match(findings[0].message, /duplicates p\.js/);
});

test("duplication: each finding references ITS OWN per-hash canonical source, not a single global region (COORD-102)", () => {
  // Two DISTINCT duplicate blocks (different hashes): block A in file1 & file2,
  // block B in file3 & file4. Plus a unique block in file5 that duplicates
  // nothing. Each A-duplicate must reference file1; each B-duplicate file3.
  const blockA = mkLines(30, (i) => `const a${i} = alpha(${i});`);
  const blockB = mkLines(30, (i) => `const b${i} = beta(${i} * 7);`);
  const unique = mkLines(30, (i) => `const u${i} = gamma(${i} - 1);`);
  const findings = checkDuplication({
    files: [
      { file: "file1.js", source: blockA },
      { file: "file2.js", source: blockA },
      { file: "file3.js", source: blockB },
      { file: "file4.js", source: blockB },
      { file: "file5.js", source: unique },
    ],
    minLines: 12,
    severity: "warn",
  });
  // One finding per duplicate occurrence (the 2nd region of each hash group);
  // the unique block yields none.
  assert.equal(findings.length, 2, "one finding per duplicate, none for the unique block");

  const aDup = findings.find((f) => f.file === "file2.js");
  const bDup = findings.find((f) => f.file === "file4.js");
  assert.ok(aDup, "expected a finding for the file2 copy of block A");
  assert.ok(bDup, "expected a finding for the file4 copy of block B");

  // The crux of COORD-102: each finding points at ITS OWN canonical source.
  assert.match(aDup.message, /duplicates file1\.js:/, "block A duplicate must reference file1, its own canonical");
  assert.match(bDup.message, /duplicates file3\.js:/, "block B duplicate must reference file3, its own canonical");
  // And NOT cross-reference the other hash group's canonical (the old bug).
  assert.doesNotMatch(aDup.message, /file3\.js/, "block A must not claim to duplicate block B's source");
  assert.doesNotMatch(bDup.message, /file1\.js/, "block B must not claim to duplicate block A's source");

  // The unique block must never appear as a finding subject.
  assert.ok(!findings.some((f) => f.file === "file5.js"), "the unique block duplicates nothing");
});

test("duplication check passes distinct files", () => {
  const findings = checkDuplication({
    files: [{ file: "a.js", source: "const x = 1;\nconst y = 2;" }, { file: "b.js", source: "const z = 3;" }],
    minLines: 12,
    severity: "warn",
  });
  assert.deepEqual(findings, []);
});

// --- runChecks / summarize / warning-first ---------------------------------

test("runChecks returns the COORD-083 finding shape", () => {
  const { findings } = runChecks({
    files: [{ file: "big.js", source: mkLines(60) }],
    config: { checks: { size: { maxLoc: 10 } } },
  });
  assert.ok(findings.length >= 1);
  const f = findings.find((x) => x.check === "size");
  // shape contract consumed by the ticket generator
  for (const key of ["check", "file", "value", "threshold", "severity", "message"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(f, key), `finding missing ${key}`);
  }
});

test("WARNING-FIRST: findings at default warn severity classify the overall result as warn, never fail", () => {
  const { summary } = runChecks({
    files: [{ file: "big.js", source: mkLines(60) }],
    config: { checks: { size: { maxLoc: 10 } } }, // severity defaults to warn
  });
  assert.equal(summary.result, "warn");
  assert.equal(summary.failCount, 0);
  assert.ok(summary.findings >= 1);
});

test("escalation-to-fail: a check with severity=fail makes the overall result fail", () => {
  const { summary } = runChecks({
    files: [{ file: "big.js", source: mkLines(60) }],
    config: { checks: { size: { maxLoc: 10, severity: "fail" } } },
  });
  assert.equal(summary.result, "fail");
  assert.ok(summary.failCount >= 1);
});

test("clean input classifies as pass", () => {
  const { summary } = runChecks({ files: [{ file: "ok.js", source: "const x = 1;\nmodule.exports = { x };\n" }] });
  assert.equal(summary.result, "pass");
  assert.equal(summary.findings, 0);
});

test("severity=off disables a check", () => {
  const { findings } = runChecks({
    files: [{ file: "big.js", source: mkLines(60) }],
    config: { checks: { size: { maxLoc: 10, severity: "off" }, monolith: { severity: "off" } } },
  });
  assert.equal(findings.filter((f) => f.check === "size").length, 0);
});

test("formatArchSummary is grep-friendly", () => {
  const { summary } = runChecks({
    files: [{ file: "big.js", source: mkLines(60) }],
    config: { checks: { size: { maxLoc: 10 } } },
  });
  const line = formatArchSummary(summary);
  assert.match(line, /^arch: (pass|warn|fail) files=\d+ findings=\d+ \(size=\d+ complexity=\d+ imports=\d+ dup=\d+ monolith=\d+ hardcoding=\d+ deadcode=\d+\)$/);
});

// --- scanRepo (fs wrapper) --------------------------------------------------

test("scanRepo reads files from disk and returns findings + summary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-scan-"));
  try {
    fs.writeFileSync(path.join(dir, "big.js"), mkLines(60));
    fs.writeFileSync(path.join(dir, "small.js"), "const x = 1;\n");
    const { findings, summary } = scanRepo({ root: dir, config: { checks: { size: { maxLoc: 10 } } } });
    assert.ok(summary.files >= 2);
    assert.ok(findings.some((f) => f.check === "size" && f.file === "big.js"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scanRepo ignores .test.js files by default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-ignore-"));
  try {
    fs.writeFileSync(path.join(dir, "huge.test.js"), mkLines(60));
    const { findings } = scanRepo({ root: dir, config: { checks: { size: { maxLoc: 10 } } } });
    assert.equal(findings.length, 0, "test files are ignored by the scan helper");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI: warning-first non-blocking + escalation ---------------------------

test("CLI classify is WARNING-FIRST: exits 0 even with warn findings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-cli-warn-"));
  try {
    fs.writeFileSync(path.join(dir, "big.js"), mkLines(60));
    const cfg = path.join(dir, "cfg.json");
    fs.writeFileSync(cfg, JSON.stringify({ checks: { size: { maxLoc: 10 } } }));
    const r = spawnSync("node", [CLI, "classify", "--root", dir, "--config", cfg], { encoding: "utf8" });
    assert.equal(r.status, 0, "warn must not block");
    assert.match(r.stdout, /^arch: warn /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI classify exits 1 when a check is escalated to fail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-cli-fail-"));
  try {
    fs.writeFileSync(path.join(dir, "big.js"), mkLines(60));
    const cfg = path.join(dir, "cfg.json");
    fs.writeFileSync(cfg, JSON.stringify({ checks: { size: { maxLoc: 10, severity: "fail" } } }));
    const r = spawnSync("node", [CLI, "classify", "--root", dir, "--config", cfg], { encoding: "utf8" });
    assert.equal(r.status, 1, "escalated fail must block");
    assert.match(r.stdout, /^arch: fail /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI classify on a clean dir exits 0 with pass", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-cli-clean-"));
  try {
    fs.writeFileSync(path.join(dir, "ok.js"), "const x = 1;\nmodule.exports = { x };\n");
    const r = spawnSync("node", [CLI, "classify", "--root", dir], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^arch: pass /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects an unknown subcommand with usage (exit 2)", () => {
  const r = spawnSync("node", [CLI, "bogus"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

// --- template gate.sh integration ------------------------------------------

test("backend/frontend gate.sh run the arch step on full but NOT on default", () => {
  for (const repo of ["backend", "frontend"]) {
    const gate = path.join(__dirname, "..", "..", repo, "scripts", "gate.sh");
    if (!fs.existsSync(gate)) continue;
    const full = spawnSync("bash", [gate, "full"], { encoding: "utf8" });
    assert.equal(full.status, 0, `${repo} full lane should pass (warning-first): ${full.stderr}`);
    assert.match(full.stdout, /architecture\/complexity guardrails \(arch-checks\)/);
    assert.match(full.stdout, /arch: (pass|warn) /, `${repo} full should emit an arch summary, non-failing by default`);

    const def = spawnSync("bash", [gate, "default"], { encoding: "utf8" });
    assert.equal(def.status, 0, `${repo} default lane should pass`);
    assert.ok(!/arch-checks/.test(def.stdout), `${repo} default lane must NOT run the arch scan`);
  }
});

// --- hardcoding detector (QSCAN-001) ---------------------------------------

test("DEFAULT_CONFIG: hardcoding + deadcode default to warn and are gateable", () => {
  assert.equal(DEFAULT_CONFIG.checks.hardcoding.severity, "warn");
  assert.equal(DEFAULT_CONFIG.checks.deadcode.severity, "warn");
  assert.ok(SEVERITIES.includes("off"));
});

test("hardcoding: flags an inline absolute/filesystem path literal", () => {
  const src = 'const p = "/var/lib/coord/runtime/state.json";\n';
  const findings = checkHardcodedLiterals({
    file: "x.js", source: src, config: DEFAULT_CONFIG.checks.hardcoding, severity: "warn",
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, "hardcoding");
  assert.equal(findings[0].line, 1);
  assert.match(findings[0].message, /hardcoded path/);
});

test("hardcoding: does NOT flag URLs, module specifiers, or prose mentioning a path", () => {
  const src = [
    'const u = "https://example.com/a/b/c";',
    'const m = require("./governance-constants.js");',
    'const msg = "see the file at /tmp/foo for details";', // prose w/ spaces -> not a path token
  ].join("\n");
  const findings = checkHardcodedLiterals({
    file: "x.js", source: src, config: DEFAULT_CONFIG.checks.hardcoding, severity: "warn",
  });
  assert.deepEqual(findings, []);
});

test("hardcoding: repeated multi-word string across files fires; a single occurrence stays silent", () => {
  const files = [
    { file: "a.js", source: 'const a = "local-review (no PR)";\n' },
    { file: "b.js", source: 'const b = "local-review (no PR)";\n' },
    { file: "c.js", source: 'const c = "local-review (no PR)";\n' },
    { file: "d.js", source: 'const once = "only appears a single time here";\n' },
  ];
  const findings = checkRepeatedStrings({
    files, config: DEFAULT_CONFIG.checks.hardcoding, severity: "warn",
  });
  assert.equal(findings.length, 1, "exactly one shared-constant opportunity");
  assert.equal(findings[0].value, 3);
  assert.match(findings[0].message, /repeated string literal/);
  assert.ok(!findings.some((f) => /only appears a single time/.test(f.message)),
    "single-occurrence literal must NOT be flagged");
});

test("hardcoding: shared vocabulary (bare enum tokens, CLI flags, import paths) is NOT flagged", () => {
  // These recur many times but are the codebase's shared lexicon, not leaks.
  const files = [
    { file: "a.js", source: 'const s = "completed"; const f = "--ticket"; const m = "../paths.js";\n' },
    { file: "b.js", source: 'const s = "completed"; const f = "--ticket"; const m = "../paths.js";\n' },
    { file: "c.js", source: 'const s = "completed"; const f = "--ticket"; const m = "../paths.js";\n' },
    { file: "d.js", source: '"use strict"; const x = require("node:path");\n' },
    { file: "e.js", source: '"use strict"; const y = require("node:path");\n' },
    { file: "f.js", source: '"use strict"; const z = require("node:path");\n' },
  ];
  const findings = checkRepeatedStrings({
    files, config: DEFAULT_CONFIG.checks.hardcoding, severity: "warn",
  });
  assert.deepEqual(findings, [], "enum/flag/import lexicon must not be flagged");
});

test("hardcoding: whitelisted numbers are not flagged when magic-numbers opt-in is enabled", () => {
  const cfg = mergeConfig({ checks: { hardcoding: { detectMagicNumbers: true, detectPaths: false, detectRepeatedStrings: false } } }).checks.hardcoding;
  const src = "const a = 1; const b = 100; const c = 0; const big = 4242;\n";
  const findings = checkHardcodedLiterals({ file: "x.js", source: src, config: cfg, severity: "warn" });
  assert.ok(findings.every((f) => f.value !== 1 && f.value !== 100 && f.value !== 0),
    "whitelisted numbers must not be flagged");
  assert.ok(findings.some((f) => f.value === 4242), "a non-whitelisted magic number IS flagged");
});

test("hardcoding: severity:off toggle disables the check in runChecks", () => {
  const files = [{ file: "x.js", source: 'const p = "/etc/coord/conf.json";\n' }];
  const on = runChecks({ files, config: { checks: offExcept("hardcoding") } });
  assert.ok(on.summary.byCheck.hardcoding >= 1);
  const off = runChecks({ files, config: { checks: { ...offExcept("hardcoding"), hardcoding: { severity: "off" } } } });
  assert.equal(off.summary.byCheck.hardcoding, 0);
});

// --- deadcode detector (QSCAN-001) -----------------------------------------

test("deadcode: extractTopLevelDefs finds top-level fn/const defs, skips nested", () => {
  const src = [
    "function alpha() { const local = 1; return local; }",
    "const beta = () => 2;",
    "  function indented() {}", // nested/indented -> NOT top-level
  ].join("\n");
  const defs = extractTopLevelDefs(src, "x.js").map((d) => d.name);
  assert.deepEqual(defs.sort(), ["alpha", "beta"]);
});

test("deadcode: flags a truly-unreferenced top-level function", () => {
  const files = [
    { file: "x.js", source: "function neverUsedHelper() { return 1; }\n" },
    { file: "y.js", source: "function used() { return 2; }\nmodule.exports = { used };\n" },
  ];
  const findings = checkDeadCode({ files, severity: "warn" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, "deadcode");
  assert.equal(findings[0].value, "neverUsedHelper");
  assert.equal(findings[0].severity, "warn");
});

test("deadcode: does NOT flag a fn referenced by a bare identifier elsewhere", () => {
  const files = [
    { file: "x.js", source: "function liveHelper() { return 1; }\n" },
    { file: "y.js", source: "function consumer() { return liveHelper(); }\nmodule.exports = { consumer };\n" },
  ];
  const findings = checkDeadCode({ files, severity: "warn" });
  assert.ok(!findings.some((f) => f.value === "liveHelper"),
    "a bare-identifier-referenced def must not be flagged");
});

test("deadcode: does NOT flag a fn exported on module.exports / __testing facade", () => {
  const files = [
    { file: "x.js", source: "function exportedFn() { return 1; }\nmodule.exports = { exportedFn };\n" },
    { file: "y.js", source: "function facadeFn() { return 2; }\nfunction host() { return { __testing: { facadeFn } }; }\nmodule.exports = host;\n" },
  ];
  const findings = checkDeadCode({ files, severity: "warn" });
  assert.ok(!findings.some((f) => f.value === "exportedFn"),
    "module.exports-listed def has >1 reference and must not be flagged");
  assert.ok(!findings.some((f) => f.value === "facadeFn"),
    "__testing-facade-listed def must not be flagged");
});

test("deadcode: does NOT flag a fn reached only by DYNAMIC DISPATCH (string key)", () => {
  // The name appears NOWHERE as a bare identifier except its definition, but a
  // command/tool table references it by string key. Must stay live.
  const files = [
    { file: "x.js", source: "function dispatchOnly() { return 1; }\n" },
    { file: "cli.js", source: 'const commands = { "dispatchOnly": null };\nmodule.exports = { commands };\n' },
  ];
  const findings = checkDeadCode({ files, severity: "warn" });
  assert.ok(!findings.some((f) => f.value === "dispatchOnly"),
    "dispatch-by-string-key def must not be flagged dead");
});

test("deadcode: cross-subtree reference (referenceFiles) keeps a def live", () => {
  // Def lives in the scanned subtree; its only reference is in a sibling
  // subtree present in referenceFiles but NOT in the scanned `files`.
  const files = [{ file: "scripts/x.js", source: "function crossRef() { return 1; }\n" }];
  const referenceFiles = files.concat([
    { file: "board/b.js", source: "const v = crossRef();\n" },
  ]);
  assert.deepEqual(checkDeadCode({ files, referenceFiles, severity: "warn" }), [],
    "a def referenced from a broader corpus must not be flagged");
  // Sanity: without the broader corpus it WOULD be flagged.
  assert.equal(checkDeadCode({ files, severity: "warn" }).length, 1);
});

test("deadcode: severity:off toggle disables the check in runChecks", () => {
  const files = [{ file: "x.js", source: "function orphan() { return 1; }\n" }];
  const on = runChecks({ files, config: { checks: offExcept("deadcode") } });
  assert.equal(on.summary.byCheck.deadcode, 1);
  const off = runChecks({ files, config: { checks: { ...offExcept("deadcode"), deadcode: { severity: "off" } } } });
  assert.equal(off.summary.byCheck.deadcode, 0);
});

// Helper: turn every check OFF except the named one (warn). Keeps these unit
// tests focused on a single detector's contribution to runChecks' summary.
function offExcept(keep) {
  const out = {};
  for (const name of CHECKS) out[name] = { severity: name === keep ? "warn" : "off" };
  return out;
}

// ===========================================================================
// COORD-126: baseline-aware (ratchet) gating.
// ===========================================================================
const {
  stableFindingKey,
  classifyFindingsAgainstBaseline,
  summarizeRatchet,
  computeBaselineFindings,
} = arch;

test("COORD-126 stableFindingKey: form is check:file:detail and is value-independent", () => {
  // The same complexity hotspot with a DIFFERENT measured value (count drifts
  // as the function is edited) must produce the SAME key.
  const a = { check: "complexity", file: "x.js", value: 20, threshold: 15, severity: "fail", message: "function foo in x.js has cyclomatic complexity ~20, over budget 15", line: 10 };
  const b = { check: "complexity", file: "x.js", value: 31, threshold: 15, severity: "fail", message: "function foo in x.js has cyclomatic complexity ~31, over budget 15", line: 88 };
  assert.equal(stableFindingKey(a), "complexity:x.js:fn:foo");
  assert.equal(stableFindingKey(a), stableFindingKey(b),
    "same function, drifted value+line -> same stable key");
});

test("COORD-126 stableFindingKey: duplication keys on the region hash, not the line", () => {
  const a = { check: "duplication", file: "x.js", value: 14, threshold: 12, severity: "warn", message: "14-line block in x.js duplicates y.js:3 (hash deadbeef)", line: 40 };
  const b = { check: "duplication", file: "x.js", value: 14, threshold: 12, severity: "warn", message: "14-line block in x.js duplicates y.js:3 (hash deadbeef)", line: 120 };
  assert.equal(stableFindingKey(a), "duplication:x.js:dup:deadbeef");
  assert.equal(stableFindingKey(a), stableFindingKey(b), "line shift must not reclassify");
});

test("COORD-126 classifyFindingsAgainstBaseline: partitions new vs pre-existing by key", () => {
  const A = { check: "complexity", file: "x.js", value: 20, threshold: 15, severity: "fail", message: "function fa in x.js has cyclomatic complexity ~20, over budget 15", line: 5 };
  const B = { check: "complexity", file: "x.js", value: 18, threshold: 15, severity: "fail", message: "function fb in x.js has cyclomatic complexity ~18, over budget 15", line: 50 };
  // base has A; current has A (pre-existing, drifted value) + B (new).
  const baseA = Object.assign({}, A, { value: 16, line: 99 });
  const { newFindings, preExistingFindings } = classifyFindingsAgainstBaseline([A, B], [baseA]);
  assert.deepEqual(newFindings.map((f) => stableFindingKey(f)), ["complexity:x.js:fn:fb"]);
  assert.deepEqual(preExistingFindings.map((f) => stableFindingKey(f)), ["complexity:x.js:fn:fa"]);
});

test("COORD-126 summarizeRatchet: fails ONLY on NEW fail-severity findings; pre-existing informational", () => {
  const cfg = mergeConfig();
  const A = { check: "complexity", file: "x.js", value: 20, threshold: 15, severity: "fail", message: "function fa in x.js has cyclomatic complexity ~20, over budget 15", line: 5 };
  const B = { check: "complexity", file: "x.js", value: 18, threshold: 15, severity: "fail", message: "function fb in x.js has cyclomatic complexity ~18, over budget 15", line: 50 };
  // base has A (pre-existing). current has A + B (new). ratchet -> fail on B only.
  const r = summarizeRatchet([A, B], cfg, 1, [A]);
  assert.equal(r.mode, "ratchet");
  assert.equal(r.result, "fail", "a NEW fail-severity finding fails the ratchet gate");
  assert.equal(r.new, 1);
  assert.equal(r.preExisting, 1);
  assert.equal(r.newFailCount, 1);
  // If B were also pre-existing, ratchet passes despite both being fail-severity.
  const clean = summarizeRatchet([A, B], cfg, 1, [A, B]);
  assert.equal(clean.result, "pass", "no NEW findings -> ratchet passes even with pre-existing fails");
  assert.equal(clean.preExisting, 2);
  // Absolute mode would FAIL on either {A} or {A,B} since both are fail-severity.
  assert.equal(summarizeFindings([A, B], cfg, 1).result, "fail");
  assert.equal(summarizeFindings([A], cfg, 1).result, "fail");
});

test("COORD-126 runChecks: archGate:ratchet + baselineFindings flips the verdict; default unchanged", () => {
  // Source with one over-budget function (escalated to fail).
  const heavy = `function hot(a){ ${"if(a){a++;} ".repeat(20)} return a; }\n`;
  const files = [{ file: "x.js", source: heavy }];
  const cfgFail = { checks: { ...offExcept("complexity"), complexity: { severity: "fail", maxComplexity: 5 } } };
  // Absolute (default): the single fail-severity finding fails.
  const abs = runChecks({ files, config: cfgFail });
  assert.equal(abs.summary.result, "fail");
  assert.equal(abs.summary.mode, undefined, "default summary carries no ratchet mode");
  // Ratchet with the SAME finding present on the base -> pre-existing -> pass.
  const baselineFindings = abs.findings;
  const rat = runChecks({ files, config: { ...cfgFail, archGate: "ratchet" }, baselineFindings });
  assert.equal(rat.summary.mode, "ratchet");
  assert.equal(rat.summary.result, "pass", "pre-existing fail does not fail ratchet");
  // Ratchet with an EMPTY baseline -> the finding is new -> fail.
  const ratNew = runChecks({ files, config: { ...cfgFail, archGate: "ratchet" }, baselineFindings: [] });
  assert.equal(ratNew.summary.result, "fail");
  assert.equal(ratNew.summary.new, 1);
  // Ratchet config WITHOUT a baseline array falls back to absolute (no silent pass).
  const noBase = runChecks({ files, config: { ...cfgFail, archGate: "ratchet" } });
  assert.equal(noBase.summary.mode, undefined);
  assert.equal(noBase.summary.result, "fail");
});

test("COORD-126 formatArchSummary: ratchet runs append the new/pre-existing split", () => {
  const cfg = mergeConfig();
  const A = { check: "size", file: "x.js", value: 9, threshold: 5, severity: "warn", message: "file x.js is 9 LOC, over budget 5" };
  const r = summarizeRatchet([A], cfg, 1, []);
  const line = formatArchSummary(r);
  assert.match(line, /ratchet new=1 pre-existing=0/);
  // Absolute summary has no ratchet suffix.
  assert.ok(!/ratchet/.test(formatArchSummary(summarizeFindings([A], cfg, 1))));
});

// --- end-to-end with a real temp git repo (worktree isolation + bound) ------

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

// Build a throwaway git repo whose BASE commit has fileA (one over-budget fn)
// and whose WORKING TREE adds fileB (a second over-budget fn) PLUS an unrelated
// line shift in fileA — exercising that the stable key ignores the churn.
function makeGitSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-ratchet-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  const heavyFn = (name) => `function ${name}(a){ ${"if(a){a++;} ".repeat(20)} return a; }\n`;
  fs.writeFileSync(path.join(dir, "a.js"), heavyFn("alpha"));
  // A config that escalates complexity to fail so the gate has a hard verdict.
  fs.writeFileSync(path.join(dir, "arch.config.json"), JSON.stringify({
    archGate: "ratchet",
    checks: Object.assign(
      { complexity: { severity: "fail", maxComplexity: 5 } },
      // turn the rest off to keep the fixture's finding set tiny + deterministic.
      Object.fromEntries(CHECKS.filter((c) => c !== "complexity").map((c) => [c, { severity: "off" }])),
    ),
  }));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base: alpha only"]);
  // Working-tree change: prepend an unrelated comment line to a.js (line churn)
  // and add b.js with a NEW over-budget fn.
  fs.writeFileSync(path.join(dir, "a.js"), "// unrelated header churn\n" + heavyFn("alpha"));
  fs.writeFileSync(path.join(dir, "b.js"), heavyFn("beta"));
  return dir;
}

test("COORD-126 CLI --baseline: ratchet fails on NEW only; churn does not reclassify pre-existing", () => {
  const dir = makeGitSandbox();
  try {
    const cfg = path.join(dir, "arch.config.json");
    // ABSOLUTE mode: both alpha + beta are fail-severity -> exit 1 (fail).
    const absOut = [];
    const absCode = runCli(["classify", "--root", dir, "--config", cfg],
      { stdout: { write: (s) => absOut.push(s) }, stderr: { write: () => {} } });
    assert.equal(absCode, 1, "absolute fails on any fail-severity finding");

    // RATCHET against the base ref: alpha is pre-existing (despite the line
    // churn), beta is NEW -> still fails (beta is a new fail) BUT the summary
    // must report new=1 pre-existing=1.
    const base = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const out = [];
    const err = [];
    const code = runCli(["classify", "--root", dir, "--config", cfg, "--baseline", base],
      { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
    const line = out.join("");
    assert.match(line, /ratchet new=1 pre-existing=1/,
      `expected new=1 pre-existing=1, got: ${line}`);
    assert.equal(code, 1, "a NEW fail-severity finding still fails ratchet");

    // Now make the WORKING TREE clean of new findings: remove b.js. alpha stays
    // pre-existing -> ratchet PASSES (exit 0) even though absolute would fail.
    fs.rmSync(path.join(dir, "b.js"));
    const out2 = [];
    const code2 = runCli(["classify", "--root", dir, "--config", cfg, "--baseline", base],
      { stdout: { write: (s) => out2.push(s) }, stderr: { write: () => {} } });
    assert.match(out2.join(""), /ratchet new=0 pre-existing=1/);
    assert.equal(code2, 0, "no NEW findings -> ratchet passes despite pre-existing debt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-126 CLI --baseline: unresolvable base ref -> graceful absolute fallback + warning", () => {
  const dir = makeGitSandbox();
  try {
    const cfg = path.join(dir, "arch.config.json");
    const out = [];
    const err = [];
    const code = runCli(["classify", "--root", dir, "--config", cfg, "--baseline", "no-such-ref-xyz"],
      { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
    assert.match(err.join(""), /WARNING ratchet requested but/, "must warn on unresolved base");
    assert.match(err.join(""), /falling back to absolute mode/);
    // Fell back to absolute -> the fail-severity findings fail the gate.
    assert.equal(code, 1);
    assert.ok(!/ratchet/.test(out.join("")), "absolute summary has no ratchet suffix");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-126 computeBaselineFindings: non-git root returns ok:false (no throw, no fallthrough)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-nogit-"));
  try {
    const res = computeBaselineFindings({ repoRoot: dir, baseRef: "HEAD" });
    assert.equal(res.ok, false);
    assert.ok(typeof res.reason === "string" && res.reason.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
