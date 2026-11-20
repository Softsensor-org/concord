"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

// COORD-078 (QGATE-004): architecture/complexity guardrail tests.
// Pure-policy + lightweight static analysis + CLI behavior, plus template
// gate.sh runner integration. WARNING-FIRST is the load-bearing default.
// No board/runtime side effects (temp fixtures only).

const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { quoteNodeOption, withoutInheritedIsolationGuardOptions } = require("./test-node-options.js");

const arch = require("./arch-checks.js");
const {
  CHECKS,
  SEVERITIES,
  DEFAULT_CONFIG,
  mergeConfig,
  stripComments,
  countLoc,
  checkFileSize,
  shouldCheckProductionModuleLoc,
  checkProductionModuleLocBudget,
  deriveProductionModuleLocBudgets,
  isCompositionRootFile,
  isAllowedCompositionRootWiringLine,
  checkCompositionRootAddedLogic,
  estimateComplexity,
  extractFunctions,
  ownComplexity,
  checkComplexity,
  extractImports,
  checkImportBoundaries,
  checkDuplication,
  checkCrossRepoDuplication,
  extractionTunedConfig,
  runCrossRepoDuplication,
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

function childProcessEnv(env) {
  const childEnv = { ...env };
  for (const name of Object.keys(childEnv)) {
    if (name.startsWith("NODE_TEST_") || name === "NODE_CHANNEL_FD") delete childEnv[name];
  }
  return childEnv;
}

function nestedGateEnv(env) {
  const childEnv = childProcessEnv(env);
  // A nested gate owns its own native coverage run. Do not let an outer
  // test-runner's raw V8 coverage directory collect snapshots from it.
  delete childEnv.NODE_V8_COVERAGE;

  // Keep exactly the current workspace guard in nested node:test workers and
  // exclude that same file from coverage. An outer sharded runner can preload
  // its checkout's guard too; counting that other copy as product code lowers
  // a nested template repo's real coverage below its configured threshold.
  const guard = resolveEngineModule(COORD_ROOT_DIR, "scripts/test-isolation-guard.js");
  const guardArg = quoteNodeOption(guard);
  const options = withoutInheritedIsolationGuardOptions(childEnv.NODE_OPTIONS || "");
  childEnv.NODE_OPTIONS = [options, `--require ${guardArg}`, `--test-coverage-exclude=${guardArg}`].filter(Boolean).join(" ");
  return childEnv;
}

function runProc(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: childProcessEnv(options.env || process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = options.timeoutMs || 15000;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
    });
  });
}

function mkLines(n, makeLine = (i) => `const v${i} = fn(${i});`) {
  return Array.from({ length: n }, (_, i) => makeLine(i)).join("\n");
}

// --- config / constants ----------------------------------------------------

test("CHECKS and SEVERITIES expose the documented vocabulary", () => {
  assert.deepEqual(CHECKS, ["size", "complexity", "imports", "duplication", "monolith", "prodloc", "compositionRoot", "hardcoding", "deadcode"]);
  assert.deepEqual(SEVERITIES, ["off", "warn", "fail"]);
});

test("DEFAULT_CONFIG is warning-first except strict engine-architecture checks", () => {
  for (const name of CHECKS) {
    if (name === "prodloc" || name === "compositionRoot") continue;
    assert.equal(DEFAULT_CONFIG.checks[name].severity, "warn", `${name} should default to warn`);
  }
  assert.equal(DEFAULT_CONFIG.checks.prodloc.severity, "fail");
  assert.equal(DEFAULT_CONFIG.checks.compositionRoot.severity, "fail");
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
    file: "coord/engine/scripts/lifecycle.js",
    source: mkLines(20),
    maxLoc: 10,
    severity: "warn",
    perFile,
  });
  assert.deepEqual(underOverride, [], "file under its per-file budget is not flagged");

  // ...and only trips once it exceeds its OWN (higher) budget, reporting that
  // budget as the threshold — not the global one.
  const overOverride = checkFileSize({
    file: "coord/engine/scripts/lifecycle.js",
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
    file: "coord/engine/scripts/lifecycle.js",
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
  // COORD-397: after extracting the residual lifecycle command/helper clusters,
  // the composition-root override is ratcheted down from the old 5000 grandfather
  // to the measured residual budget.
  assert.equal(DEFAULT_CONFIG.checks.size.perFile["lifecycle.js"], 2600);
  // mergeConfig preserves the default perFile map when an unrelated field is overridden.
  const merged = mergeConfig({ checks: { size: { severity: "fail" } } });
  assert.equal(merged.checks.size.perFile["lifecycle.js"], 2600);
});

test("production-module LOC check is scoped to non-test coord/scripts modules", () => {
  assert.equal(shouldCheckProductionModuleLoc("coord/scripts/foo.js", DEFAULT_CONFIG.checks.prodloc), true);
  assert.equal(shouldCheckProductionModuleLoc("coord/scripts/enterprise/foo.js", DEFAULT_CONFIG.checks.prodloc), true);
  assert.equal(shouldCheckProductionModuleLoc("coord/scripts/foo.test.js", DEFAULT_CONFIG.checks.prodloc), false);
  assert.equal(shouldCheckProductionModuleLoc("coord/scripts/__fixtures__/foo.js", DEFAULT_CONFIG.checks.prodloc), false);
  assert.equal(shouldCheckProductionModuleLoc("backend/src/foo.js", DEFAULT_CONFIG.checks.prodloc), false);
});

test("production-module LOC check fails new modules above 1200 and ignores tests", () => {
  const hit = checkProductionModuleLocBudget({
    file: "coord/scripts/new-monolith.js",
    source: mkLines(1201),
    severity: DEFAULT_CONFIG.checks.prodloc.severity,
  });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].check, "prodloc");
  assert.equal(hit[0].severity, "fail");
  assert.equal(hit[0].threshold, 1200);
  assert.match(hit[0].message, /production-module high-water LOC budget/);

  const ignoredTest = checkProductionModuleLocBudget({
    file: "coord/scripts/new-monolith.test.js",
    source: mkLines(5000),
    config: DEFAULT_CONFIG.checks.prodloc,
    severity: "fail",
  });
  assert.deepEqual(ignoredTest, []);
});

test("production-module LOC check honors high-water budgets as growth caps", () => {
  const cfg = {
    maxLoc: 1200,
    severity: "fail",
    include: ["coord/scripts/"],
    highWater: { "coord/scripts/legacy.js": 10 },
  };
  assert.deepEqual(
    checkProductionModuleLocBudget({
      file: "coord/scripts/legacy.js",
      source: mkLines(10),
      config: cfg,
      severity: "fail",
    }),
    [],
    "a tracked module at its high-water budget passes",
  );
  const grown = checkProductionModuleLocBudget({
    file: "coord/scripts/legacy.js",
    source: mkLines(11),
    config: cfg,
    severity: "fail",
  });
  assert.equal(grown.length, 1);
  assert.equal(grown[0].threshold, 10);
  assert.match(grown[0].message, /high-water LOC budget/);
  assert.doesNotMatch(grown[0].message, /grandfather/i);
});

test("production-module LOC budgets derive a downward high-water mark after shrink", () => {
  const cfg = {
    maxLoc: 1200,
    include: ["coord/scripts/"],
    highWater: {
      "coord/scripts/legacy.js": 2000,
      "coord/scripts/small.js": 1300,
    },
  };
  const budgets = deriveProductionModuleLocBudgets({
    config: cfg,
    files: [
      { file: "coord/scripts/legacy.js", source: mkLines(1500) },
      { file: "coord/scripts/small.js", source: mkLines(800) },
      { file: "coord/scripts/new.js", source: mkLines(300) },
      { file: "coord/scripts/new.test.js", source: mkLines(5000) },
    ],
  });
  assert.equal(budgets["coord/scripts/legacy.js"], 1500, "shrinking a tracked hotspot lowers its cap");
  assert.equal(budgets["coord/scripts/small.js"], 1200, "tracked modules below the global cap lower to the global cap");
  assert.equal(budgets["coord/scripts/new.js"], 1200, "new modules keep the global cap");
  assert.equal(budgets["coord/scripts/new.test.js"], undefined, "tests are not budgeted");
});

test("DEFAULT_CONFIG prodloc high-water budgets are current and do not use grandfather exemptions", () => {
  assert.ok(DEFAULT_CONFIG.checks.prodloc.highWater, "prodloc exposes highWater budgets");
  assert.equal(DEFAULT_CONFIG.checks.prodloc.grandfather, undefined, "grandfather exemptions are not part of the default policy");
  for (const [file, budget] of Object.entries(DEFAULT_CONFIG.checks.prodloc.highWater)) {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", file), "utf8");
    const { loc } = countLoc(source);
    assert.ok(loc <= budget, `${file} current LOC ${loc} must be within its high-water budget ${budget}`);
  }
});

test("composition-root guard is scoped to lifecycle and governance-validation", () => {
  assert.equal(isCompositionRootFile("coord/engine/scripts/lifecycle.js", DEFAULT_CONFIG.checks.compositionRoot), true);
  assert.equal(isCompositionRootFile("coord/engine/scripts/governance-validation.js", DEFAULT_CONFIG.checks.compositionRoot), true);
  assert.equal(isCompositionRootFile("coord/scripts/new-command.js", DEFAULT_CONFIG.checks.compositionRoot), false);
});

test("composition-root guard allows wiring-only added lines", () => {
  const allowed = [
    "",
    "'use strict';",
    '"use strict";',
    'const createFoo = require("./foo.js");',
    "const {",
    "  fooCommand,",
    '} = require("./foo-command.js");',
    "fooCommand,",
    "module.exports = {",
    "foo: fooCommand,",
    '"foo-alias": fooCommand,',
    "};",
    "exports.foo = fooCommand;",
    "// wiring comment",
  ];
  for (const line of allowed) {
    assert.equal(isAllowedCompositionRootWiringLine(line), true, `expected wiring line to pass: ${line}`);
  }
  const findings = checkCompositionRootAddedLogic({
    file: "coord/engine/scripts/lifecycle.js",
    addedLines: allowed.map((text, i) => ({ text, lineNumber: i + 1 })),
    config: DEFAULT_CONFIG.checks.compositionRoot,
    severity: "fail",
  });
  assert.deepEqual(findings, []);
});

test("composition-root guard fails appended logic in both roots", () => {
  for (const file of ["coord/engine/scripts/lifecycle.js", "coord/engine/scripts/governance-validation.js"]) {
    const findings = checkCompositionRootAddedLogic({
      file,
      addedLines: [
        { text: "function appendedBusinessLogic() { return true; }", lineNumber: 10 },
        { text: "if (ticket.highRisk) fail('blocked');", lineNumber: 11 },
      ],
      config: DEFAULT_CONFIG.checks.compositionRoot,
      severity: "fail",
    });
    assert.equal(findings.length, 2);
    assert.equal(findings[0].check, "compositionRoot");
    assert.equal(findings[0].severity, "fail");
    assert.match(findings[0].message, /self-registering module/);
  }
  const file = "coord/engine/scripts/lifecycle.js";
  const [withoutLine] = checkCompositionRootAddedLogic({
    file,
    addedLines: [null, "if (featureEnabled) runFeature();"],
    severity: "fail",
  });
  assert.equal(withoutLine.value, "if (featureEnabled) runFeature();");
  assert.equal(withoutLine.line, undefined);
  assert.deepEqual(checkCompositionRootAddedLogic({ file, addedLines: null, severity: "fail" }), []);
});

test("composition-root guard ignores self-registering modules outside the roots", () => {
  const findings = checkCompositionRootAddedLogic({
    file: "coord/scripts/commands/new-command.js",
    addedLines: [{ text: "function newCommand() { return true; }", lineNumber: 1 }],
    config: DEFAULT_CONFIG.checks.compositionRoot,
    severity: "fail",
  });
  assert.deepEqual(findings, []);
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
    file: "coord/engine/scripts/cli.js",
    source: "const rbac = require('./enterprise/enterprise-rbac-policy.js');",
    rules,
    severity: "fail",
  });
  assert.equal(coreImportsEnt.length, 1, "core->enterprise import must be flagged");
  assert.equal(coreImportsEnt[0].check, "imports");
  assert.match(coreImportsEnt[0].message, /open-core boundary/);

  // a CORE module reaching enterprise via a relative climb -> FLAGGED
  const coreImportsEntRel = checkImportBoundaries({
    file: "coord/engine/scripts/lifecycle.js",
    source: "const c = require('../scripts/enterprise/enterprise-broker-contract.js');",
    rules,
    severity: "fail",
  });
  assert.equal(coreImportsEntRel.length, 1, "core->enterprise (relative) import must be flagged");

  // an ENTERPRISE module importing CORE -> ALLOWED (enterprise may depend on core)
  const entImportsCore = checkImportBoundaries({
    file: "coord/engine/scripts/enterprise/enterprise-broker-contract.js",
    source: "const id = require('../identity-v2.js'); const j = require('../journal.js');",
    rules,
    severity: "fail",
  });
  assert.deepEqual(entImportsCore, [], "enterprise->core import must be allowed");

  // an ENTERPRISE module importing an ENTERPRISE sibling -> ALLOWED (not self-flagged)
  const entImportsEntSibling = checkImportBoundaries({
    file: "coord/engine/scripts/enterprise/enterprise-broker-contract.js",
    source: "const p = require('./enterprise-rbac-policy.js');",
    rules,
    severity: "fail",
  });
  assert.deepEqual(entImportsEntSibling, [], "enterprise->enterprise sibling import must be allowed");

  // a CORE module that does NOT touch enterprise -> ALLOWED
  const coreNeutral = checkImportBoundaries({
    file: "coord/engine/scripts/cli.js",
    source: "const j = require('./journal.js');",
    rules,
    severity: "fail",
  });
  assert.deepEqual(coreNeutral, [], "core->core import must be allowed");

  // COORD-874: the subtree now lives under coord/engine/scripts/enterprise/.
  // A CORE engine module reaching into it -> FLAGGED
  const engineCoreImportsEnt = checkImportBoundaries({
    file: "coord/engine/scripts/recall.js",
    source: "const rbac = require('./enterprise/enterprise-rbac-policy.js');",
    rules,
    severity: "fail",
  });
  assert.equal(engineCoreImportsEnt.length, 1, "core engine->enterprise import must be flagged");
  assert.match(engineCoreImportsEnt[0].message, /open-core boundary/);

  // the moved ENTERPRISE modules importing core or each other -> ALLOWED
  const engineEntImports = checkImportBoundaries({
    file: "coord/engine/scripts/enterprise/broker-core.js",
    source: "const p = require('./enterprise-rbac-policy.js'); const { resolveEngineModule } = require('../../../paths.js');",
    rules,
    severity: "fail",
  });
  assert.deepEqual(engineEntImports, [], "engine enterprise->core and enterprise->enterprise imports must be allowed");
});

// COORD-873 (human-admin ruling 2026-11-04): the boundary covers core modules at both the
// legacy coord/scripts path and the engine path they migrate to, and the enterprise subtree
// stays carved out at both (COORD-874 moves it under coord/engine/scripts/enterprise/).
test("COORD-873: the open-core boundary holds in coord/scripts and coord/engine/scripts", () => {
  const rules = DEFAULT_CONFIG.checks.imports.rules;
  const check = (file, source) => checkImportBoundaries({ file, source, rules, severity: "fail" });
  for (const file of ["coord/scripts/sample-module.js", "coord/engine/scripts/lifecycle.js", "coord/engine/scripts/hooks/hook-lib.js"]) {
    const flagged = check(file, "const rbac = require('./enterprise/enterprise-rbac-policy.js');");
    assert.equal(flagged.length, 1, `${file}: core->enterprise import is flagged`);
    assert.match(flagged[0].message, /open-core boundary/);
    assert.deepEqual(check(file, "const j = require('./journal.js');"), [], `${file}: core->core stays allowed`);
  }
  for (const file of ["coord/scripts/enterprise/x.js", "coord/engine/scripts/enterprise/x.js"]) {
    assert.deepEqual(check(file, "const p = require('./enterprise-rbac-policy.js'); const c = require('../journal.js');"), [],
      `${file}: enterprise may import enterprise siblings and core`);
  }
  assert.deepEqual(check("coord/board/board.js", "require('./enterprise/x.js')"), [], "the boundary is scoped to the scripts trees");
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

// --- extraction-tuned cross-repo duplication (COORD-136) -------------------

test("extraction-tuned mode flags a small cross-repo copy that the DEFAULT gate (minLines 12) misses", () => {
  // An 8-line block duplicated across two repos. Below the default minLines:12
  // (so the default gate sees nothing) but above the tuned minLines:6.
  const block = mkLines(8, (i) => `const dup${i} = compute(${i});`);
  const files = [
    { file: "frontend/util.js", source: block, repo: "frontend" },
    { file: "backend/util.js", source: block, repo: "backend" },
  ];
  // DEFAULT gate: minLines 12 → does not see the 8-line block.
  const defaultFindings = checkDuplication({ files, minLines: 12, severity: "warn" });
  assert.equal(defaultFindings.length, 0, "default gate (minLines 12) must miss the small cross-repo copy");
  // Extraction-tuned: lower minLines → catches it AND tags it cross-repo.
  const tuned = checkCrossRepoDuplication({ files, minLines: 6, severity: "warn" });
  assert.equal(tuned.length, 1, "tuned gate (minLines 6) flags the small cross-repo copy");
  assert.equal(tuned[0].check, "duplication");
  assert.match(tuned[0].message, /\[cross-repo: backend->frontend\]|\[cross-repo: frontend->backend\]/);
  assert.match(tuned[0].message, /packages\/shared/);
});

test("crossRepoOnly mode ignores INTRA-repo duplication (that is the default gate's job)", () => {
  const block = mkLines(8, (i) => `const local${i} = thing(${i});`);
  // Both copies in the SAME repo → cross-repo mode must not flag it.
  const files = [
    { file: "frontend/a.js", source: block, repo: "frontend" },
    { file: "frontend/b.js", source: block, repo: "frontend" },
  ];
  const tuned = checkCrossRepoDuplication({ files, minLines: 6, severity: "warn", crossRepoOnly: true });
  assert.deepEqual(tuned, [], "intra-repo duplication is out of scope for the cross-repo extraction gate");
});

test("repo is inferred from the leading path segment when no repo tag is given", () => {
  const block = mkLines(8, (i) => `const seg${i} = pick(${i});`);
  const files = [
    { file: "frontend/x.js", source: block },
    { file: "coord-ui/x.js", source: block },
  ];
  const tuned = checkCrossRepoDuplication({ files, minLines: 6, severity: "warn" });
  assert.equal(tuned.length, 1, "leading-segment repo inference detects the cross-repo copy");
  assert.match(tuned[0].message, /cross-repo: (frontend->coord-ui|coord-ui->frontend)/);
});

test("extractionTunedConfig swaps in the tuned duplication profile WITHOUT touching the default", () => {
  const tunedCfg = extractionTunedConfig();
  assert.equal(tunedCfg.checks.duplication.minLines, 6, "tuned config uses the lower minLines");
  // The shipped DEFAULT_CONFIG is untouched.
  assert.equal(DEFAULT_CONFIG.checks.duplication.minLines, 12, "default duplication minLines is unchanged");
  assert.equal(DEFAULT_CONFIG.checks.duplication.extractionTuned.minLines, 6);
  // mergeConfig (the default path) still yields the default thresholds.
  assert.equal(mergeConfig().checks.duplication.minLines, 12, "default merge path is unperturbed");
});

test("runCrossRepoDuplication ratchet: pre-existing cross-repo dup passes, NEW cross-repo dup fails", () => {
  const blockOld = mkLines(8, (i) => `const old${i} = legacy(${i});`);
  const blockNew = mkLines(8, (i) => `const fresh${i} = added(${i});`);
  // The base (pre-existing) corpus already has the OLD block duplicated across repos.
  const baseFiles = [
    { file: "frontend/legacy.js", source: blockOld, repo: "frontend" },
    { file: "backend/legacy.js", source: blockOld, repo: "backend" },
  ];
  // Compute the baseline findings under the SAME tuned mode.
  const baseRun = runCrossRepoDuplication({ files: baseFiles });
  assert.equal(baseRun.findings.length, 1, "baseline has one pre-existing cross-repo dup");

  // Current corpus: the SAME pre-existing dup is still there → must NOT fail.
  const ratchetCfg = { archGate: "ratchet" };
  const preExistingOnly = runCrossRepoDuplication({
    files: baseFiles,
    config: ratchetCfg,
    baselineFindings: baseRun.findings,
  });
  assert.equal(preExistingOnly.summary.mode, "ratchet");
  assert.equal(preExistingOnly.summary.result, "pass", "pre-existing cross-repo divergence is frictionless");
  assert.equal(preExistingOnly.summary.new, 0);
  assert.equal(preExistingOnly.summary.preExisting, 1);

  // Now a NEW cross-repo dup is added (escalated to fail severity) → must fail.
  const currentFiles = baseFiles.concat([
    { file: "frontend/fresh.js", source: blockNew, repo: "frontend" },
    { file: "coord-ui/fresh.js", source: blockNew, repo: "coord-ui" },
  ]);
  const withNew = runCrossRepoDuplication({
    files: currentFiles,
    config: { archGate: "ratchet", checks: { duplication: { severity: "fail", extractionTuned: { minLines: 6, severity: "fail", crossRepoOnly: true } } } },
    baselineFindings: baseRun.findings,
  });
  assert.equal(withNew.summary.result, "fail", "NEW cross-repo divergence is pressured (fails the ratchet)");
  assert.equal(withNew.summary.new, 1, "exactly the newly-added cross-repo dup is new");
  assert.ok(withNew.summary.preExisting >= 1, "the old dup is still reported as pre-existing");
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
  assert.match(line, /^arch: (pass|warn|fail) files=\d+ findings=\d+ \(size=\d+ complexity=\d+ imports=\d+ dup=\d+ monolith=\d+ prodloc=\d+ compositionRoot=\d+ hardcoding=\d+ deadcode=\d+\)$/);
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

function runArchCli(argv) {
  const stdout = [];
  const stderr = [];
  const status = runCli(argv, {
    stdout: { write: (s) => stdout.push(s) },
    stderr: { write: (s) => stderr.push(s) },
  });
  return { status, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("CLI classify is WARNING-FIRST: exits 0 even with warn findings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-cli-warn-"));
  try {
    fs.writeFileSync(path.join(dir, "big.js"), mkLines(60));
    const cfg = path.join(dir, "cfg.json");
    fs.writeFileSync(cfg, JSON.stringify({ checks: { size: { maxLoc: 10 } } }));
    const r = runArchCli(["classify", "--root", dir, "--config", cfg]);
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
    const r = runArchCli(["classify", "--root", dir, "--config", cfg]);
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
    const r = runArchCli(["classify", "--root", dir]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^arch: pass /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects an unknown subcommand with usage (exit 2)", () => {
  const r = runArchCli(["bogus"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test("nested gate environment keeps the isolation guard active and excludes it from coverage", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "arch-nested-gate-env-"));
  const fixture = path.join(temp, "guard-preload.test.js");
  const guard = resolveEngineModule(COORD_ROOT_DIR, "scripts/test-isolation-guard.js");
  const protectedProbe = path.join(__dirname, "..", "..", "prompts", ".coord-859-guard-probe");
  try {
    fs.writeFileSync(fixture, [
      '"use strict";',
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      'const fs = require("node:fs");',
      'test("guard is preloaded and rejects governed writes", () => {',
      '  assert.ok(require.cache[process.env.COORD_TEST_GUARD_PATH]);',
      '  assert.throws(() => fs.writeFileSync(process.env.COORD_TEST_GUARD_PROBE, "blocked"), /test-isolation-guard.*BLOCKED/i);',
      '});',
      "",
    ].join("\n"));

    for (const [name, nodeOptions] of [
      ["exclusion-only", `--experimental-sqlite --test-coverage-exclude=${guard}`],
      ["already-preloaded", `--experimental-sqlite --require ${guard} --test-coverage-exclude=${guard}`],
    ]) {
      const rawCoverage = path.join(temp, `${name}-outer-v8`);
      fs.mkdirSync(rawCoverage);
      const env = nestedGateEnv({
        ...process.env,
        NODE_OPTIONS: nodeOptions,
        NODE_V8_COVERAGE: rawCoverage,
        COORD_TEST_GUARD_PATH: guard,
        COORD_TEST_GUARD_PROBE: protectedProbe,
      });
      assert.equal(env.NODE_V8_COVERAGE, undefined);
      assert.match(env.NODE_OPTIONS, /--experimental-sqlite/);
      assert.match(env.NODE_OPTIONS, /--require\s+\S*test-isolation-guard\.js/);
      assert.match(env.NODE_OPTIONS, /--test-coverage-exclude=\S*test-isolation-guard\.js/);
      assert.equal((env.NODE_OPTIONS.match(/--require\s/g) || []).length, 1, `${name} should carry one guard preload`);

      const result = await runProc(process.execPath, ["--test", "--experimental-test-coverage", fixture], { env });
      assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /guard is preloaded and rejects governed writes/);
      assert.doesNotMatch(result.stdout, /test-isolation-guard\.js/);
      assert.deepEqual(fs.readdirSync(rawCoverage), [], `${name} child must not write into outer raw coverage`);
    }
    assert.equal(fs.existsSync(protectedProbe), false, "guarded probe must remain absent");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// --- template gate.sh integration ------------------------------------------

test("backend/frontend gate.sh run the arch step on full but NOT on default", async () => {
  for (const repo of ["backend", "frontend"]) {
    const gate = path.join(__dirname, "..", "..", "..", repo, "scripts", "gate.sh");
    if (!fs.existsSync(gate)) continue;
    if (repo === "frontend") {
      // A shard is a fresh Git clone: ignored dependencies from the invoking
      // checkout are absent. Install the real UI's locked dependencies before
      // exercising its gate; missing dependencies must never skip UI tests.
      const app = path.resolve(path.dirname(gate), "..", "apps", "coord-ui");
      const requireUi = require("node:module").createRequire(path.join(app, "package.json"));
      let dependenciesPresent = true;
      for (const name of ["typescript", "react", "react-dom/server"]) {
        try { requireUi.resolve(name); } catch { dependenciesPresent = false; }
      }
      if (!dependenciesPresent) {
        const installed = await runProc("npm", ["ci", "--prefix", app, "--no-audit", "--no-fund"], {
          timeoutMs: 120000, env: nestedGateEnv(process.env),
        });
        assert.equal(installed.timedOut, false, "locked UI dependency installation timed out");
        assert.equal(installed.status, 0, `locked UI dependencies must install: ${installed.stderr}\n${installed.stdout}`);
      }
    }
    const rawCoverage = fs.mkdtempSync(path.join(os.tmpdir(), `arch-${repo}-outer-v8-`));
    const guard = resolveEngineModule(COORD_ROOT_DIR, "scripts/test-isolation-guard.js");
    const inheritedGuardDir = fs.mkdtempSync(path.join(os.tmpdir(), "arch inherited alias "));
    const inheritedGuardAlias = path.join(inheritedGuardDir, "test-isolation-guard.js");
    fs.symlinkSync(guard, inheritedGuardAlias);
    let full;
    try {
      const inheritedOptions = [
        process.env.NODE_OPTIONS || "",
        `-r ${quoteNodeOption(inheritedGuardAlias)}`,
        `--test-coverage-exclude=${quoteNodeOption(inheritedGuardAlias)}`,
      ].filter(Boolean).join(" ");
      full = await runProc("bash", [gate, "full"], {
        timeoutMs: 120000,
        env: nestedGateEnv({ ...process.env, NODE_OPTIONS: inheritedOptions, NODE_V8_COVERAGE: rawCoverage }),
      });
      assert.equal(full.timedOut, false, `${repo} full lane timed out: ${full.stderr}\n${full.stdout}`);
      assert.equal(full.status, 0, `${repo} full lane should pass (warning-first): ${full.stderr}\n${full.stdout}`);
      assert.match(full.stdout, /coverage: pass\b/, `${repo} full lane must measure and pass its configured coverage threshold`);
      const report = path.join(__dirname, "..", "..", "artifacts", "gates", repo, "coverage-full.txt");
      assert.doesNotMatch(fs.readFileSync(report, "utf8"), /test-isolation-guard\.js/, `${repo} coverage must exclude test harness code`);
      assert.deepEqual(fs.readdirSync(rawCoverage), [], `${repo} nested gate must not write into the outer raw coverage directory`);
    } finally {
      fs.rmSync(rawCoverage, { recursive: true, force: true });
      fs.rmSync(inheritedGuardDir, { recursive: true, force: true });
    }
    assert.match(full.stdout, /architecture\/complexity guardrails \(arch-checks\)/);
    assert.match(full.stdout, /arch: (pass|warn) /, `${repo} full should emit an arch summary, non-failing by default`);
    if (repo === "frontend") {
      assert.doesNotMatch(full.stderr, /node:test run\(\) is being called recursively/, "frontend full must not inherit the parent node:test context");
      assert.match(full.stdout, /clean nested lock passes/, "frontend full must execute nested coord-ui tests, not skip them under an inherited node:test context");
    }

    const defaultRawCoverage = fs.mkdtempSync(path.join(os.tmpdir(), `arch-${repo}-default-outer-v8-`));
    try {
      const def = await runProc("bash", [gate, "default"], {
        timeoutMs: 120000,
        env: nestedGateEnv({ ...process.env, NODE_V8_COVERAGE: defaultRawCoverage }),
      });
      assert.equal(def.timedOut, false, `${repo} default lane timed out: ${def.stderr}\n${def.stdout}`);
      assert.equal(def.status, 0, `${repo} default lane should pass: ${def.stderr}\n${def.stdout}`);
      assert.ok(!/arch-checks/.test(def.stdout), `${repo} default lane must NOT run the arch scan`);
      assert.deepEqual(fs.readdirSync(defaultRawCoverage), [], `${repo} default gate must not write into outer raw coverage`);
    } finally {
      fs.rmSync(defaultRawCoverage, { recursive: true, force: true });
    }
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
    "  function indented() {}",
    "function () {}",
    "const = 3;",
    "let { destructured } = source;",
  ].join("\n");
  assert.deepEqual(extractTopLevelDefs(src, "x.js"), [
    { name: "alpha", line: 1, file: "x.js" },
    { name: "beta", line: 2, file: "x.js" },
  ]);
});

test("deadcode: an unavailable source contributes no top-level definitions", () => {
  assert.deepEqual(extractTopLevelDefs(null, "x.js"), []);
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

  const config = { checks: offExcept("deadcode") };
  const broader = runChecks({ files, config, referenceFiles });
  assert.deepEqual(broader.findings, []);
  assert.equal(broader.summary.files, 1, "only the selected subtree is scanned for definitions");
  const narrower = runChecks({ files, config, referenceFiles: [] });
  assert.deepEqual(narrower.findings.map(({ value }) => value), ["crossRef"]);
  assert.equal(runChecks({ files: null, config, referenceFiles }).summary.files, 0);
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
  parseUnifiedDiffAddedLines,
  computeDiffAddedLines,
  computeBaselineFindings,
} = arch;

test("COORD-396 parseUnifiedDiffAddedLines feeds composition-root guard", () => {
  const diff = [
    "diff --git a/coord/engine/scripts/lifecycle.js b/coord/engine/scripts/lifecycle.js",
    "--- a/coord/engine/scripts/lifecycle.js",
    "+++ b/coord/engine/scripts/lifecycle.js",
    "@@ -10,0 +11,2 @@",
    "+const createFoo = require(\"./foo.js\");",
    "+function appendedLogic() { return true; }",
  ].join("\n");
  const parsed = parseUnifiedDiffAddedLines(diff);
  const findings = checkCompositionRootAddedLogic({
    file: "coord/engine/scripts/lifecycle.js",
    addedLines: parsed["coord/engine/scripts/lifecycle.js"],
    config: DEFAULT_CONFIG.checks.compositionRoot,
    severity: "fail",
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 12);
  assert.match(findings[0].value, /appendedLogic/);
});

test("COORD-786 composition-root diff survives a large unrelated coverage artifact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-large-diff-"));
  try {
    gitFixture(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@t.t"]);
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    fs.mkdirSync(path.join(dir, "coord", "engine", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "coord", "engine", "scripts", "lifecycle.js"), '"use strict";\n');
    fs.writeFileSync(path.join(dir, "coverage-baseline.json"), "{}\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const base = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    fs.appendFileSync(path.join(dir, "coord", "engine", "scripts", "lifecycle.js"),
      "function appendedLogic() { return true; }\n");
    fs.writeFileSync(path.join(dir, "coverage-baseline.json"),
      JSON.stringify({ findings: "x".repeat(9 * 1024 * 1024) }));

    const diff = computeDiffAddedLines({ repoRoot: dir, baseRef: base,
      roots: ["coord/engine/scripts/lifecycle.js"] });
    assert.equal(diff.ok, true, diff.reason);
    assert.deepEqual(Object.keys(diff.addedLinesByFile), ["coord/engine/scripts/lifecycle.js"]);
    const defaultRoots = computeDiffAddedLines({ repoRoot: dir, baseRef: base });
    assert.equal(defaultRoots.ok, true, defaultRoots.reason);
    assert.deepEqual(defaultRoots.addedLinesByFile, diff.addedLinesByFile);
    const findings = checkCompositionRootAddedLogic({
      file: "coord/engine/scripts/lifecycle.js",
      addedLines: diff.addedLinesByFile["coord/engine/scripts/lifecycle.js"],
      config: DEFAULT_CONFIG.checks.compositionRoot,
      severity: "fail",
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-126 stableFindingKey: form is check:file:detail and is value-independent", () => {
  // The same complexity hotspot with a DIFFERENT measured value (count drifts
  // as the function is edited) must produce the SAME key.
  const a = { check: "complexity", file: "x.js", value: 20, threshold: 15, severity: "fail", message: "function foo in x.js has cyclomatic complexity ~20, over budget 15", line: 10 };
  const b = { check: "complexity", file: "x.js", value: 31, threshold: 15, severity: "fail", message: "function foo in x.js has cyclomatic complexity ~31, over budget 15", line: 88 };
  assert.equal(stableFindingKey(a), "complexity:x.js:fn:foo");
  assert.equal(stableFindingKey(a), stableFindingKey(b),
    "same function, drifted value+line -> same stable key");
});

test("unnamed complexity findings without a location use a stable baseline identity", () => {
  const finding = { check: "complexity", file: "x.js", message: "complexity budget exceeded" };
  assert.equal(stableFindingKey(finding), "complexity:x.js:fn:line0");
  assert.equal(stableFindingKey({ ...finding, line: 8 }), "complexity:x.js:fn:line8");
});

test("COORD-126 stableFindingKey: duplication keys on the region hash, not the line", () => {
  const a = { check: "duplication", file: "x.js", value: 14, threshold: 12, severity: "warn", message: "14-line block in x.js duplicates y.js:3 (hash deadbeef)", line: 40 };
  const b = { check: "duplication", file: "x.js", value: 14, threshold: 12, severity: "warn", message: "14-line block in x.js duplicates y.js:3 (hash deadbeef)", line: 120 };
  assert.equal(stableFindingKey(a), "duplication:x.js:dup:deadbeef");
  assert.equal(stableFindingKey(a), stableFindingKey(b), "line shift must not reclassify");
});

test("COORD-786 hardcoding identity defaults an omitted finding line to zero", () => {
  const key = arch.stableFindingKey({ check: "hardcoding", file: "coord/scripts/example.js", value: "literal" });
  assert.equal(key, "hardcoding:coord/scripts/example.js:hc:literal:line0");
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

const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");

function git(cwd, args) {
  return gitFixtureSpawn(cwd, args);
}

// Build a throwaway git repo whose BASE commit has fileA (one over-budget fn)
// and whose WORKING TREE adds fileB (a second over-budget fn) PLUS an unrelated
// line shift in fileA — exercising that the stable key ignores the churn.
function makeGitSandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arch-ratchet-")));
  gitFixture(dir, ["init", "-q"]);
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

test("COORD-396 CLI --baseline fails when a composition root gains non-wiring logic", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-composition-root-"));
  try {
    gitFixture(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@t.t"]);
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    fs.mkdirSync(path.join(dir, "coord", "engine", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "coord", "engine", "scripts", "lifecycle.js"), '"use strict";\nmodule.exports = {\n};\n');
    const cfg = path.join(dir, "arch.config.json");
    fs.writeFileSync(cfg, JSON.stringify({
      archGate: "ratchet",
      checks: Object.assign(
        { compositionRoot: { severity: "fail" } },
        Object.fromEntries(CHECKS.filter((c) => c !== "compositionRoot").map((c) => [c, { severity: "off" }])),
      ),
    }));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const base = git(dir, ["rev-parse", "HEAD"]).stdout.trim();

    fs.appendFileSync(path.join(dir, "coord", "engine", "scripts", "lifecycle.js"), 'function appendedLogic() { return true; }\n');
    const out = [];
    const code = runCli(["classify", "--root", dir, "--config", cfg, "--baseline", base],
      { stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} } });
    assert.equal(code, 1);
    assert.match(out.join(""), /compositionRoot=1/);
    assert.match(out.join(""), /ratchet new=1 pre-existing=0/);
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

// ===========================================================================
// COORD-284: arch-debt PREVENTION ratchet — monolith/size escalated to
// fail-on-NEW, existing over-budget files grandfathered. The escalation is the
// `ratchetFailOnNew` config seam: a check listed there hard-fails when NEW vs
// the baseline even though its OWN severity stays "warn" (so plain absolute
// classify + the no-baseline fallback never start failing).
// ===========================================================================
const { resolveDefaultBaselineRef } = arch;

// N lines of real code so countLoc counts them (one `const vK = K;` per line).
function genCodeLines(n) {
  let s = "";
  for (let i = 0; i < n; i += 1) s += `const v${i} = ${i};\n`;
  return s;
}

// A git sandbox whose BASE commit holds `baseFiles` ({ name: lineCount }) plus a
// production-shaped ratchet config: size budget 5, size at WARN severity but
// escalated to fail-on-NEW via ratchetFailOnNew (monolith too); every other
// check off so the finding set is tiny + deterministic.
function makeSizeRatchetSandbox(baseFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-ratchet284-"));
  gitFixture(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "arch.config.json"), JSON.stringify({
    archGate: "ratchet",
    ratchetFailOnNew: ["size", "monolith"],
    checks: Object.assign(
      { size: { maxLoc: 5, severity: "warn" } },
      Object.fromEntries(CHECKS.filter((c) => c !== "size").map((c) => [c, { severity: "off" }])),
    ),
  }));
  for (const [name, lines] of Object.entries(baseFiles)) {
    fs.writeFileSync(path.join(dir, name), genCodeLines(lines));
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

// Table-driven: each row sets up a base state, mutates the working tree, then
// asserts the ratchet verdict (exit code + new/pre-existing accounting).
const RATCHET_284_CASES = [
  {
    name: "grow a previously-UNDER-budget file PAST budget -> NEW size finding -> FAIL",
    base: { "f.js": 3 },
    work: (dir) => fs.writeFileSync(path.join(dir, "f.js"), genCodeLines(8)),
    expectCode: 1,
    expectMatch: /size=1.*ratchet new=1 pre-existing=0/,
  },
  {
    name: "add a brand-NEW over-budget file -> NEW size finding -> FAIL",
    base: { "under.js": 2 },
    work: (dir) => fs.writeFileSync(path.join(dir, "new.js"), genCodeLines(9)),
    expectCode: 1,
    expectMatch: /ratchet new=1 pre-existing=0/,
  },
  {
    name: "existing over-budget file UNCHANGED -> grandfathered (PRE-EXISTING) -> PASS",
    base: { "big.js": 8 },
    work: () => {},
    expectCode: 0,
    expectMatch: /ratchet new=0 pre-existing=1/,
  },
  {
    name: "existing over-budget file with unrelated other-file churn -> still grandfathered -> PASS",
    base: { "big.js": 8, "side.js": 2 },
    work: (dir) => fs.writeFileSync(path.join(dir, "side.js"), genCodeLines(3)),
    expectCode: 0,
    expectMatch: /ratchet new=0 pre-existing=1/,
  },
  {
    name: "over-budget file SHRINKS back under budget -> no finding -> PASS",
    base: { "big.js": 8 },
    work: (dir) => fs.writeFileSync(path.join(dir, "big.js"), genCodeLines(3)),
    expectCode: 0,
    expectMatch: /ratchet new=0 pre-existing=0/,
  },
  {
    name: "file stays UNDER budget -> no finding -> PASS",
    base: { "s.js": 3 },
    work: (dir) => fs.writeFileSync(path.join(dir, "s.js"), genCodeLines(4)),
    expectCode: 0,
    expectMatch: /ratchet new=0 pre-existing=0/,
  },
];

for (const tc of RATCHET_284_CASES) {
  test(`COORD-284 ratchet classify: ${tc.name}`, () => {
    const dir = makeSizeRatchetSandbox(tc.base);
    try {
      const base = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
      tc.work(dir);
      const out = [];
      const code = runCli(
        ["classify", "--root", dir, "--config", path.join(dir, "arch.config.json"), "--baseline", base],
        { stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} } },
      );
      const line = out.join("");
      assert.equal(code, tc.expectCode, `expected exit ${tc.expectCode}, got ${code}: ${line}`);
      assert.match(line, tc.expectMatch, `summary did not match: ${line}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("COORD-284 ratchet: NEW over-budget file with an UNRESOLVABLE baseline -> safe absolute fallback (does NOT fail)", () => {
  // The gate must never brick on a missing ref: with no reachable baseline the
  // run falls back to ABSOLUTE, where size stays WARN (not escalated) -> exit 0
  // even though a ratchet against a real base WOULD have failed this diff.
  const dir = makeSizeRatchetSandbox({ "under.js": 2 });
  try {
    fs.writeFileSync(path.join(dir, "grown.js"), genCodeLines(9)); // would be NEW under a real base
    const out = [];
    const err = [];
    const code = runCli(
      ["classify", "--root", dir, "--config", path.join(dir, "arch.config.json"), "--baseline", "no-such-ref-xyz"],
      { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } },
    );
    assert.equal(code, 0, "no reachable baseline -> non-failing absolute fallback");
    assert.match(err.join(""), /WARNING ratchet requested but/);
    assert.ok(!/ratchet/.test(out.join("")), "absolute fallback summary carries no ratchet suffix");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ratchet auto-selects a resolvable baseline and fails on new growth", () => {
  const dir = makeSizeRatchetSandbox({ "under.js": 2 });
  const original = process.env.GATE_ARCH_BASELINE;
  const out = [];
  const err = [];
  try {
    process.env.GATE_ARCH_BASELINE = "HEAD";
    fs.writeFileSync(path.join(dir, "grown.js"), genCodeLines(9));
    const status = runCli(
      ["classify", "--root", dir, "--config", path.join(dir, "arch.config.json"), "--ratchet"],
      { stdout: { write: (line) => out.push(line) }, stderr: { write: (line) => err.push(line) } },
    );
    assert.equal(status, 1);
    assert.match(err.join(""), /ratchet baseline auto-resolved to "HEAD"/);
    assert.match(out.join(""), /ratchet new=1 pre-existing=0/);
  } finally {
    if (original === undefined) delete process.env.GATE_ARCH_BASELINE;
    else process.env.GATE_ARCH_BASELINE = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-284 summarizeRatchet: ratchetFailOnNew escalates a NEW warn finding to fail; pre-existing stays grandfathered", () => {
  const cfg = mergeConfig({ archGate: "ratchet", ratchetFailOnNew: ["size"], checks: { size: { severity: "warn" } } });
  const pre = { check: "size", file: "old.js", value: 9, threshold: 5, severity: "warn", message: "old.js 9 LOC over budget 5" };
  const fresh = { check: "size", file: "new.js", value: 9, threshold: 5, severity: "warn", message: "new.js 9 LOC over budget 5" };
  // pre-existing only -> no NEW -> pass.
  assert.equal(summarizeRatchet([pre], cfg, 1, [pre]).result, "pass");
  // a NEW size finding (warn severity) -> escalated to FAIL via ratchetFailOnNew.
  const withNew = summarizeRatchet([pre, fresh], cfg, 2, [pre]);
  assert.equal(withNew.result, "fail", "NEW size finding escalated to fail-on-new");
  assert.equal(withNew.new, 1);
  assert.equal(withNew.preExisting, 1);
  // WITHOUT ratchetFailOnNew the same NEW warn finding is only a warn (default seam off).
  const cfgOff = mergeConfig({ archGate: "ratchet", checks: { size: { severity: "warn" } } });
  assert.equal(summarizeRatchet([pre, fresh], cfgOff, 2, [pre]).result, "warn",
    "without the escalation list a NEW warn finding stays warn (bare --ratchet unchanged)");
});

test("COORD-284 resolveDefaultBaselineRef: returns the first RESOLVABLE candidate, else null", () => {
  const dir = makeSizeRatchetSandbox({ "x.js": 1 });
  try {
    // HEAD always resolves; an all-bogus candidate list returns null (no throw).
    assert.equal(resolveDefaultBaselineRef({ repoRoot: dir, candidates: ["nope-1", "HEAD", "main"] }), "HEAD");
    assert.equal(resolveDefaultBaselineRef({ repoRoot: dir, candidates: ["nope-1", "nope-2"] }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-284 mergeConfig + checked-in ratchet config: carries ratchetFailOnNew = [monolith,size] under archGate ratchet", () => {
  // Engine default is empty (bare --ratchet does not silently fail).
  assert.deepEqual(DEFAULT_CONFIG.ratchetFailOnNew, []);
  assert.deepEqual(mergeConfig({}).ratchetFailOnNew, []);
  assert.deepEqual(mergeConfig({ ratchetFailOnNew: ["size"] }).ratchetFailOnNew, ["size"]);
  // The checked-in gate config wires monolith+size under ratchet mode.
  const cfgPath = path.join(__dirname, "..", "..", "config", "arch-gate.ratchet.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.equal(cfg.archGate, "ratchet");
  assert.ok(cfg.ratchetFailOnNew.includes("monolith") && cfg.ratchetFailOnNew.includes("size"));
  // size/monolith are NOT flipped to fail severity (stay warn for plain classify).
  const merged = mergeConfig(cfg);
  assert.equal(merged.checks.size.severity, "warn");
  assert.equal(merged.checks.monolith.severity, "warn");
});

for (const sample of [
  { name: "nested interpolation comments at depth two", source: 'const value = `outer ${\n  /* nested comment\n     remains a comment */\n  `inner ${\n    /* deeper comment */\n    1\n  }`\n}`;\n', loc: 5 },
  { name: "regex class slash quote and backtick", source: 'const pattern = /[/"`]/;\n// a real comment\nconst value = 1;\n', loc: 2 },
  { name: "object braces inside interpolation", source: 'const value = `outer ${\n  ({ value: "}" }).value\n  // comment within interpolation\n}`;\n', loc: 3 },
  { name: "nested literal text resembling comments", source: 'const value = `outer ${\n  `inner\n// literal text\n${1 /* actual comment */}`\n}`;\n', loc: 5 },
  { name: "string delimiters inside interpolation", source: 'const value = `outer ${\n  "/* text */" + \'// text\'\n  /* actual comment */\n}`;\n', loc: 3 },
  { name: "division remains code", source: 'const value = 12 / 3 / 2;\n// actual comment\nconst other = value / 2;\n', loc: 2 },
  { name: "escaped slash in regex class", source: 'const pattern = /[\\/"`]/;\n/* actual comment */\nconst value = pattern.test("/");\n', loc: 2 },
  { name: "literal multiline template text", source: 'const value = `\n// literal text\n/* literal text */\n`;\n// actual comment\n', loc: 4 },
  { name: "three interpolation levels", source: "const value = `a ${\n  `b ${\n    `c ${\n      /* nested comment */\n      1\n    }`\n  }`\n}`;\n", loc: 7 },
  { name: "multiple interpolations and function braces", source: "const value = `a ${(() => {\n  /* actual comment */\n  return { value: 1 };\n  // genuine comment after the object closes\n})().value} b ${\n  /* another comment */\n  2\n}`;\n", loc: 5 },
  { name: "escaped interpolation and backtick text", source: "const value = `literal \\${text} \\`\n// still literal text\n`;\n// actual comment\n", loc: 3 },
  { name: "regex braces inside interpolation", source: "const value = `a ${\n  /[{}\"`]/.test(\"}\")\n  /* actual comment */\n}`;\n", loc: 3 },
  { name: "regex after return", source: "function value() {\n  return /[\"`]/;\n}\n// actual comment\nconst n = 1;\n", loc: 4 },
  { name: "regex after throw", source: "function value() {\n  throw /[\"`]/;\n}\n// actual comment\nconst n = 1;\n", loc: 4 },
  { name: "regex after nested control condition", source: "if (Boolean(true)) /[\"`]/.test(\"x\");\n// actual comment\nconst n = 1;\n", loc: 2 },
  { name: "division after string and regex values", source: "const a = \"12\" / 2;\n// actual comment\nconst b = /x/ / 2;\n// another comment\n", loc: 2 },
  { name: "division after keyword property call", source: "const a = object.return(12) / 2;\n// actual comment\nconst b = object.if(true) / 2;\n// another comment\n", loc: 2 },
  { name: "division across line comments", source: "const a = 12 // actual comment\n / 2;\n// another comment\n", loc: 2 },
]) {
  test(`COORD-655: countLoc preserves ${sample.name}`, () => {
    assert.doesNotThrow(() => new Function(sample.source), "fixture must be syntactically valid JavaScript");
    assert.equal(countLoc(sample.source).loc, sample.loc);
    assert.equal(stripComments(sample.source).split("\n").length, sample.source.split("\n").length, "comment removal preserves line boundaries");
  });
}

// --- COORD-817: corpus completeness (fail closed on an unreadable corpus) ----
// A scan that could not enumerate/read its corpus is a FAILED scan, never a
// clean one. A readable directory that genuinely holds no source stays a pass.

// chmod-based cases need a non-root POSIX user (root bypasses mode bits).
const CAN_DENY_READ = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;
const OFF_CHECKS = { checks: Object.fromEntries(CHECKS.map((c) => [c, { severity: "off" }])) };

function assertCorpusError(fn, { path: wantPath, osCode }) {
  assert.throws(fn, (e) => {
    assert.equal(e.code, "ARCH_CORPUS_UNREADABLE");
    assert.equal(e.path, wantPath);
    assert.equal(e.cause && e.cause.code, osCode);
    assert.ok(e.message.includes(wantPath), `message names the path: ${e.message}`);
    assert.ok(e.message.includes(osCode), `message carries the OS error: ${e.message}`);
    return true;
  });
}

function withTmp(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    // restore traversal bits so cleanup of a chmod-000 fixture succeeds.
    spawnSync("chmod", ["-R", "u+rwx", dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("COORD-817 scanRepo/collectFiles reject an absent root with path + OS error", () => {
  withTmp("arch-817-absent-", (dir) => {
    const missing = path.join(dir, "no-such-root");
    assertCorpusError(() => scanRepo({ root: missing }), { path: missing, osCode: "ENOENT" });
    assertCorpusError(() => arch.collectFiles(missing, mergeConfig()), { path: missing, osCode: "ENOENT" });
  });
});

test("COORD-817 scanRepo rejects a non-directory root", () => {
  withTmp("arch-817-notdir-", (dir) => {
    const file = path.join(dir, "root.js");
    fs.writeFileSync(file, "const x = 1;\n");
    assertCorpusError(() => scanRepo({ root: file }), { path: file, osCode: "ENOTDIR" });
  });
});

test("COORD-817 scanRepo rejects an unreadable root", { skip: !CAN_DENY_READ }, () => {
  withTmp("arch-817-root-eacces-", (dir) => {
    fs.writeFileSync(path.join(dir, "ok.js"), "const x = 1;\n");
    fs.chmodSync(dir, 0o000);
    assertCorpusError(() => scanRepo({ root: dir }), { path: dir, osCode: "EACCES" });
  });
});

test("COORD-817 scanRepo rejects an unreadable in-scope subdirectory", { skip: !CAN_DENY_READ }, () => {
  withTmp("arch-817-sub-eacces-", (dir) => {
    fs.writeFileSync(path.join(dir, "ok.js"), "const x = 1;\n");
    const sub = path.join(dir, "locked");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "hidden.js"), mkLines(60));
    fs.chmodSync(sub, 0o000);
    assertCorpusError(() => scanRepo({ root: dir }), { path: sub, osCode: "EACCES" });
  });
});

test("COORD-817 scanRepo rejects an unreadable in-scope source file", { skip: !CAN_DENY_READ }, () => {
  withTmp("arch-817-src-eacces-", (dir) => {
    const src = path.join(dir, "locked.js");
    fs.writeFileSync(src, mkLines(60));
    fs.chmodSync(src, 0o000);
    assertCorpusError(() => scanRepo({ root: dir }), { path: src, osCode: "EACCES" });
  });
});

test("COORD-817 scanRepo rejects an in-scope source it cannot read (dangling symlink; portable)", { skip: process.platform === "win32" }, () => {
  withTmp("arch-817-dangling-", (dir) => {
    const src = path.join(dir, "gone.js");
    fs.symlinkSync(path.join(dir, "target-does-not-exist.js"), src);
    assertCorpusError(() => scanRepo({ root: dir }), { path: src, osCode: "ENOENT" });
  });
});

test("COORD-817 scanRepo rejects a supplied referenceRoot it cannot enumerate", () => {
  withTmp("arch-817-ref-", (dir) => {
    fs.writeFileSync(path.join(dir, "ok.js"), "const x = 1;\n");
    const missing = path.join(dir, "no-such-reference-root");
    assertCorpusError(() => scanRepo({ root: dir, referenceRoot: missing }), { path: missing, osCode: "ENOENT" });
  });
});

test("COORD-817 a readable, genuinely empty directory is a pass with files=0 (absolute)", () => {
  withTmp("arch-817-empty-", (dir) => {
    const { findings, summary } = scanRepo({ root: dir });
    assert.deepEqual(findings, []);
    assert.equal(summary.files, 0);
    assert.equal(summary.result, "pass");
    const r = runArchCli(["classify", "--root", dir]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^arch: pass files=0 findings=0 /);
    assert.equal(r.stderr, "");
  });
});

test("COORD-817 configured ignores are never traversed, so an unreadable ignored tree still passes", { skip: !CAN_DENY_READ }, () => {
  withTmp("arch-817-ignore-", (dir) => {
    fs.writeFileSync(path.join(dir, "ok.js"), "const x = 1;\n");
    // default-ignored fragments (.worktrees/, .next/, node_modules/), the
    // hard-skipped .git, and a caller-configured fragment (vendor/).
    for (const name of [".worktrees", ".next", "node_modules", ".git", "vendor"]) {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, "big.js"), mkLines(60));
      fs.chmodSync(path.join(dir, name), 0o000);
    }
    const ignore = [...DEFAULT_CONFIG.ignore, "vendor/"];
    const files = arch.collectFiles(dir, mergeConfig({ ignore }));
    assert.deepEqual(files, [path.join(dir, "ok.js")]);
    const { summary } = scanRepo({ root: dir, config: Object.assign({ ignore }, OFF_CHECKS) });
    assert.equal(summary.files, 1);
    assert.equal(summary.result, "pass");
    // the same tree WITHOUT the caller's ignore has an unreadable in-scope dir.
    assertCorpusError(() => scanRepo({ root: dir, config: OFF_CHECKS }), { path: path.join(dir, "vendor"), osCode: "EACCES" });
  });
});

test("COORD-817 CLI absolute: absent and non-directory roots exit 2 with path + OS error and no summary", () => {
  withTmp("arch-817-cli-abs-", (dir) => {
    const missing = path.join(dir, "no-such-root");
    const file = path.join(dir, "root.js");
    fs.writeFileSync(file, "const x = 1;\n");
    for (const [root, osCode] of [[missing, "ENOENT"], [file, "ENOTDIR"]]) {
      const r = runArchCli(["classify", "--root", root]);
      assert.equal(r.status, 2, `${osCode} root must not exit 0`);
      assert.equal(r.stdout, "", "no arch: summary line for a failed scan");
      assert.match(r.stderr, /^arch: ERROR /m);
      assert.ok(r.stderr.includes(root) && r.stderr.includes(osCode), r.stderr);
    }
  });
});

test("COORD-817 CLI ratchet: absent and non-directory roots exit 2 with path + OS error and no summary", () => {
  withTmp("arch-817-cli-ratchet-", (dir) => {
    const missing = path.join(dir, "no-such-root");
    const file = path.join(dir, "root.js");
    fs.writeFileSync(file, "const x = 1;\n");
    for (const [root, osCode] of [[missing, "ENOENT"], [file, "ENOTDIR"]]) {
      for (const flags of [["--ratchet"], ["--baseline", "HEAD"]]) {
        const r = runArchCli(["classify", "--root", root, ...flags]);
        assert.equal(r.status, 2, `${osCode} root must not exit 0 under ${flags.join(" ")}`);
        assert.equal(r.stdout, "", "no arch: summary line for a failed scan");
        assert.match(r.stderr, /^arch: ERROR /m);
        assert.ok(r.stderr.includes(root) && r.stderr.includes(osCode), r.stderr);
      }
    }
  });
});

test("COORD-817 CLI ratchet: an unreadable in-scope subdirectory fails the scan", { skip: !CAN_DENY_READ }, () => {
  const dir = makeGitSandbox();
  try {
    const cfg = path.join(dir, "arch.config.json");
    const base = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const sub = path.join(dir, "locked");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "hidden.js"), "const x = 1;\n");
    fs.chmodSync(sub, 0o000);
    const r = runArchCli(["classify", "--root", dir, "--config", cfg, "--baseline", base]);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.includes("arch: ERROR ") && r.stderr.includes(sub) && r.stderr.includes("EACCES"), r.stderr);
  } finally {
    spawnSync("chmod", ["-R", "u+rwx", dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-817 CLI ratchet: a readable, genuinely empty corpus is a ratchet pass with files=0", () => {
  withTmp("arch-817-empty-ratchet-", (dir) => {
    gitFixture(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@t.t"]);
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    git(dir, ["commit", "-q", "--allow-empty", "-m", "base: empty"]);
    const base = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const r = runArchCli(["classify", "--root", dir, "--baseline", base]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^arch: pass files=0 findings=0 .* ratchet new=0 pre-existing=0/);
    assert.ok(!/ERROR|WARNING/.test(r.stderr), r.stderr);
  });
});

test("COORD-817 ratchet baseline: a scanned subtree absent AT THE BASE REF is a legitimately empty baseline", () => {
  const dir = makeGitSandbox();
  try {
    const cfg = path.join(dir, "arch.config.json");
    const base = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const pkg = path.join(dir, "pkg");
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, "c.js"), `function gamma(a){ ${"if(a){a++;} ".repeat(20)} return a; }\n`);
    const baseline = arch.computeBaselineFindings({ repoRoot: pkg, baseRef: base, config: JSON.parse(fs.readFileSync(cfg, "utf8")) });
    assert.equal(baseline.ok, true, baseline.reason);
    assert.deepEqual(baseline.findings, []);
    const r = runArchCli(["classify", "--root", pkg, "--config", cfg, "--baseline", base]);
    assert.match(r.stdout, /ratchet new=1 pre-existing=0/, r.stdout + r.stderr);
    assert.equal(r.status, 1, "everything under a subtree new since the base is NEW debt");
    assert.ok(!/falling back to absolute/.test(r.stderr), r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- COORD-817: the fail-closed paths around the scan (no reliance on mode bits)

function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

// Run `fn` with `git` resolving ONLY to a scripted stand-in, so a git that
// misbehaves at one exact step is reproducible without permissions or timing.
function withFakeGit(body, fn) {
  return withTmp("arch-817-fakegit-", (dir) => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\ncase "$1 $2" in\n${body}\nesac\nexit 0\n`, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      return fn(dir);
    } finally {
      process.env.PATH = prevPath;
    }
  });
}
const FAKE_GIT = { skip: process.platform === "win32" };
const FAKE_SHA = "0123456789abcdef0123456789abcdef01234567";
const RESOLVES = `  "rev-parse --verify") echo ${FAKE_SHA} ;;`;

test("COORD-817 scanRepo and computeBaselineFindings default an omitted root to the working directory", () => {
  withTmp("arch-817-cwd-", (dir) => {
    fs.writeFileSync(path.join(dir, "only.js"), "const x = 1;\n");
    withCwd(dir, () => {
      const { summary } = scanRepo({ config: OFF_CHECKS });
      assert.equal(summary.files, 1, "the working directory is the scanned corpus");
      assert.equal(summary.result, "pass");
      // the same (non-git) working directory has no resolvable base ref.
      const res = computeBaselineFindings({ baseRef: "HEAD" });
      assert.equal(res.ok, false);
      assert.match(res.reason, /^base ref "HEAD" could not be resolved/);
    });
  });
});

test("COORD-817 computeBaselineFindings: a git that reports success but names no commit is an unresolved base", FAKE_GIT, () => {
  withFakeGit(`  "rev-parse --verify") ;;`, (dir) => {
    const res = computeBaselineFindings({ repoRoot: dir, baseRef: "main" });
    assert.deepEqual(res, { ok: false, reason: 'base ref "main" could not be resolved (offline, shallow, or absent)' });
  });
});

test("COORD-817 computeBaselineFindings: a failed baseline worktree is reported with git's own reason", FAKE_GIT, () => {
  const prefix = "could not create baseline worktree for main: ";
  withFakeGit(`${RESOLVES}\n  "worktree add") echo "fatal: worktree refused" >&2; exit 128 ;;`, (dir) => {
    const res = computeBaselineFindings({ repoRoot: dir, baseRef: "main" });
    assert.equal(res.ok, false);
    assert.equal(res.reason.trim(), `${prefix}fatal: worktree refused`);
  });
  // silent failure: no stderr and no spawn error to quote.
  withFakeGit(`${RESOLVES}\n  "worktree add") exit 1 ;;`, (dir) => {
    assert.deepEqual(computeBaselineFindings({ repoRoot: dir, baseRef: "main" }), { ok: false, reason: `${prefix}unknown` });
  });
  // git disappears between resolving the ref and adding the worktree: the
  // spawn error is the only reason available and must be surfaced.
  withFakeGit(`  "rev-parse --verify") echo ${FAKE_SHA}; /bin/rm -f "$0" ;;`, (dir) => {
    const res = computeBaselineFindings({ repoRoot: dir, baseRef: "main" });
    assert.equal(res.ok, false);
    assert.ok(res.reason.startsWith(prefix) && res.reason.includes("ENOENT"), res.reason);
  });
});

test("COORD-817 computeBaselineFindings: an absent baseline worktree ROOT is a failed baseline, not an empty one", FAKE_GIT, () => {
  // `worktree add` claims success without creating anything and the repo top is
  // unknown, so the scan root is the worktree itself. The ENOENT exemption is
  // for a SUBTREE only; a missing worktree root must fail the baseline scan.
  withFakeGit(RESOLVES, (dir) => {
    const res = computeBaselineFindings({ repoRoot: dir, baseRef: "main" });
    assert.equal(res.ok, false);
    assert.match(res.reason, /^baseline scan failed: architecture corpus unreadable: cannot enumerate directory .*arch-baseline-.*ENOENT/);
    assert.equal(res.findings, undefined, "no empty finding set is returned for an unscannable baseline");
  });
});

test("COORD-817 computeBaselineFindings never throws to the caller, even for a non-Error failure", () => {
  const dir = makeGitSandbox();
  try {
    const base = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const config = { get checks() { throw "raw config failure"; } };
    const res = computeBaselineFindings({ repoRoot: dir, baseRef: base, config });
    assert.deepEqual(res, { ok: false, reason: "baseline scan failed: raw config failure" });
    assert.ok(!git(dir, ["worktree", "list"]).stdout.includes("arch-baseline-"), "the throwaway worktree is still removed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("baseline scans the checkout if canonicalizing its source subtree fails", (t) => {
  const dir = makeSizeRatchetSandbox({ "oversize.js": 9 });
  try {
    const subtree = path.join(dir, "subtree");
    fs.mkdirSync(subtree);
    const realpathSync = fs.realpathSync;
    t.mock.method(fs, "realpathSync", (file, ...args) => {
      if (file === subtree) throw Object.assign(new Error("fixture subtree lost access"), { code: "EACCES" });
      return realpathSync(file, ...args);
    });

    const config = JSON.parse(fs.readFileSync(path.join(dir, "arch.config.json"), "utf8"));
    const result = computeBaselineFindings({ repoRoot: subtree, baseRef: "HEAD", config });
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.findings.map(({ check, file }) => [check, file]), [["size", "oversize.js"]]);
    assert.doesNotMatch(git(dir, ["worktree", "list"]).stdout, /arch-baseline-/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-817 CLI: an unreadable --config exits 2 naming the config, with no summary", () => {
  withTmp("arch-817-cli-config-", (dir) => {
    fs.writeFileSync(path.join(dir, "ok.js"), "const x = 1;\n");
    const missing = path.join(dir, "no-such-config.json");
    const r = runArchCli(["classify", "--root", dir, "--config", missing]);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "", "no arch: summary line when the config could not be read");
    assert.ok(r.stderr.startsWith(`arch: ERROR could not read config ${missing}: `) && r.stderr.includes("ENOENT"), r.stderr);
  });
});

test("COORD-817 computeDiffAddedLines: a failed diff always carries a reason (spawn error, else a fixed fallback)", FAKE_GIT, () => {
  // git exits non-zero without saying why.
  withFakeGit(`  "diff --unified=0") exit 1 ;;`, (dir) => {
    assert.deepEqual(computeDiffAddedLines({ repoRoot: dir, baseRef: "main" }), { ok: false, reason: "git diff failed" });
  });
  // git cannot be spawned at all: the spawn error is the reason.
  withFakeGit("", (dir) => {
    fs.rmSync(path.join(dir, "bin", "git"));
    const res = computeDiffAddedLines({ repoRoot: dir, baseRef: "main" });
    assert.equal(res.ok, false);
    assert.match(res.reason, /ENOENT/);
  });
});

test("COORD-817 CLI ratchet: a failed composition-root diff is warned about and the ratchet verdict still stands", () => {
  const dir = makeGitSandbox();
  try {
    const cfg = path.join(dir, "arch.config.json");
    const config = JSON.parse(fs.readFileSync(cfg, "utf8"));
    // a composition root outside the repository makes `git diff` itself fail.
    config.checks.compositionRoot = { severity: "off", roots: ["../outside-the-repo.js"] };
    fs.writeFileSync(cfg, JSON.stringify(config));
    const base = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const r = runArchCli(["classify", "--root", dir, "--config", cfg, "--baseline", base]);
    assert.match(r.stderr, /^arch: WARNING composition-root diff guard disabled: .*outside/m);
    assert.ok(!/falling back to absolute/.test(r.stderr), r.stderr);
    assert.match(r.stdout, /ratchet new=1 pre-existing=1/, r.stdout + r.stderr);
    assert.equal(r.status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// COORD-871 (human-admin ruling 2026-11-04): the COORD-589 migration moves budgeted
// modules into coord/engine/scripts, so the default size check must measure that
// tree too, and a budget keyed by an engine path must still cap growth.
test("COORD-871: the default production-module LOC check covers coord/engine/scripts and its budgets", () => {
  const cfg = DEFAULT_CONFIG.checks.prodloc;
  assert.ok(cfg.include.includes("coord/engine/scripts/"), "engine scripts are in the include scope");
  assert.ok(cfg.include.includes("coord/scripts/"), "legacy scripts stay in scope");
  const over = checkProductionModuleLocBudget({
    file: "coord/engine/scripts/new-engine-module.js",
    source: mkLines(cfg.maxLoc + 1),
    config: cfg,
    severity: "fail",
  });
  assert.equal(over.length, 1, "an unbudgeted engine module over the global cap fails");
  assert.equal(over[0].threshold, cfg.maxLoc);
  const budgeted = Object.keys(cfg.highWater).find((file) => file.startsWith("coord/engine/scripts/"));
  assert.ok(budgeted, "at least one budget is keyed by its engine path");
  const cap = cfg.highWater[budgeted];
  assert.deepEqual(checkProductionModuleLocBudget({ file: budgeted, source: mkLines(cap), config: cfg, severity: "fail" }), []);
  const grown = checkProductionModuleLocBudget({ file: budgeted, source: mkLines(cap + 1), config: cfg, severity: "fail" });
  assert.equal(grown.length, 1, `${budgeted} growing past its carried budget fails`);
  assert.equal(grown[0].threshold, cap);
  assert.deepEqual(checkProductionModuleLocBudget({
    file: "coord/engine/scripts/new-engine-module.test.js", source: mkLines(cfg.maxLoc + 1), config: cfg, severity: "fail",
  }), [], "engine suites stay unbudgeted");
});

// COORD-1015: git reports the REAL toplevel. A caller reaching the same subtree
// through a symlinked parent must scan the same subtree as the real path, or the
// baseline keys stop lining up and every finding is mis-classified as NEW.
test("COORD-1015 computeBaselineFindings: a subtree reached through a symlinked parent scans the same subtree", () => {
  const dir = makeGitSandbox();
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "arch-1015-link-"));
  try {
    const pkg = path.join(dir, "pkg");
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, "c.js"), `function gamma(a){ ${"if(a){a++;} ".repeat(20)} return a; }\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base: pkg subtree"]);
    const base = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const config = JSON.parse(fs.readFileSync(path.join(dir, "arch.config.json"), "utf8"));
    const link = path.join(linkParent, "repo");
    fs.symlinkSync(dir, link, "dir");
    const files = (res) => {
      assert.equal(res.ok, true, res.reason);
      return res.findings.map((f) => f.file).sort();
    };
    const real = files(arch.computeBaselineFindings({ repoRoot: pkg, baseRef: base, config }));
    const viaLink = files(arch.computeBaselineFindings({ repoRoot: path.join(link, "pkg"), baseRef: base, config }));
    assert.ok(real.length > 0, "the fixture must carry a baseline finding");
    assert.deepEqual(viaLink, real);
  } finally {
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-1048: composition wiring recognizes only identity forwarders and static member references", () => {
  for (const text of ["readBoard: (...args) => readBoard(...args),", "fail: (...a) => fail(...a),", "runtimeDir: state.RUNTIME_DIR,"]) {
    assert.equal(isAllowedCompositionRootWiringLine(text), true, text);
  }
  for (const text of [
    "readBoard: (...args) => other(...args),", "readBoard: (...args) => readBoard(args),",
    "readBoard: (...args) => readBoard(...other),", "readBoard: (...args) => readBoard(...args, true),",
    "readBoard: (...args) => { return readBoard(...args); },", "readBoard: (...args) => ok ? readBoard(...args) : null,",
    "readBoard: (...args) => (effect(), readBoard(...args)),", "readBoard: async (...args) => readBoard(...args),",
    "runtimeDir: state[getKey()],", "runtimeDir: state.RUNTIME_DIR(),", "get runtimeDir() { return state.RUNTIME_DIR; },",
  ]) assert.equal(isAllowedCompositionRootWiringLine(text), false, text);
});

test("COORD-1048: composition dependency bundles require pure immutable local wiring", () => {
  const base = ["const reads = {", "readBoard: (...args) => readBoard(...args),", "runtimeDir: state.RUNTIME_DIR,", "};", "const { command } = createCommands({", "...reads,", "});"];
  const check = (lines) => checkCompositionRootAddedLogic({
    file: "coord/engine/scripts/lifecycle.js", source: lines.join("\n"),
    addedLines: [{ text: lines[0], line: 1 }, { text: lines[5], line: 6 }],
    config: DEFAULT_CONFIG.checks.compositionRoot, severity: "fail",
  });
  assert.deepEqual(check(base), []);
  assert.deepEqual(check([...base, "const labels = { reads: 'reads' };", "const label = labels.reads;"]), []);
  for (const reference of ["const snapshot = { reads };", "const labels = { [reads]: true };", "const value = other[reads];"]) {
    assert.equal(check([...base, reference]).length, 2, reference);
  }
  const { dependencyBundleWiringLines } = require("./composition-root-wiring.js");
  assert.deepEqual(dependencyBundleWiringLines(base.join("\n") + "\nconst broken = {"), new Set());
  assert.deepEqual(dependencyBundleWiringLines([...base, ";".repeat(100001)].join("\n")), new Set(),
    "the AST limit cannot partially credit wiring");
  const manyBundles = Array.from({ length: 800 }, (_, i) =>
    `const bundle${i} = { readBoard }; createCommands({ ...bundle${i} });`);
  assert.deepEqual(dependencyBundleWiringLines([...base, ...manyBundles].join("\n")), new Set(),
    "the binding reference limit cannot partially credit wiring");
  for (const unsafe of [
    "readBoard: effect(),", "readBoard: (...args) => other(...args),", "readBoard: (...args) => readBoard(...args, true),",
    "readBoard: (...args) => { return readBoard(...args); },", "readBoard: flag ? readBoard : other,",
    "get readBoard() { return readBoard; },", "[effect()]: readBoard,", "readBoard: { nested: effect() },", "...unknown,",
  ]) {
    const lines = [...base]; lines[1] = unsafe;
    assert.equal(check(lines).length, 2, unsafe);
  }
  for (const mutation of ["reads.readBoard = other;", "delete reads.readBoard;", "reads = other;", "Object.assign(reads, other);", "const alias = reads;", "use(reads);", "function f(reads) {}", "const { readBoard: alias } = reads;"]) {
    assert.equal(check([...base, mutation]).length, 2, mutation);
  }
  const mutable = [...base]; mutable[0] = "let reads = {";
  assert.equal(check(mutable).length, 2);
  const unknown = [...base]; unknown[5] = "...unknown,";
  assert.equal(check(unknown).length, 2);
  for (const receiver of ["const value = unrelated({", "const value = new createCommands({", "const value = ns.createCommands({",
    "const value = createCommands?.({", "const value = (flag ? createCommands : other)({",
    "const value = {", "module.exports = {", "function build() { return {"]) {
    const lines = [...base]; lines[4] = receiver;
    if (receiver === "const value = {" || receiver === "module.exports = {") lines[6] = "};";
    if (receiver.startsWith("function")) lines[6] = "}; }";
    assert.equal(check(lines).length, 2, receiver);
  }
  const unused = base.slice(0, 4);
  assert.equal(checkCompositionRootAddedLogic({ file: "coord/engine/scripts/lifecycle.js", source: unused.join("\n"),
    addedLines: [{ text: unused[0], line: 1 }], config: DEFAULT_CONFIG.checks.compositionRoot, severity: "fail" }).length, 1);
  const mixed = [...base]; mixed[0] = "effect(); const reads = {";
  assert.equal(check(mixed).length, 1);
  const noContext = checkCompositionRootAddedLogic({ file: "coord/engine/scripts/lifecycle.js",
    addedLines: [{ text: "...reads,", line: 6 }], config: DEFAULT_CONFIG.checks.compositionRoot, severity: "fail" });
  assert.equal(noContext.length, 1);
});

test("COORD-1048: lifecycle factory wiring retains its shared deferred read dependencies", () => {
  const source = fs.readFileSync(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle.js"), "utf8");
  const addedLines = source.split("\n").flatMap((text, index) =>
    /^\s*(?:const ticketReadDependencies = \{|\.\.\.ticketReadDependencies,)$/.test(text)
      ? [{ text, line: index + 1 }] : []);
  assert.ok(addedLines.length > 1, "expected the bundle declaration and its factory injection sites");
  assert.deepEqual(checkCompositionRootAddedLogic({ file: "coord/engine/scripts/lifecycle.js", source,
    addedLines, config: DEFAULT_CONFIG.checks.compositionRoot, severity: "fail" }), []);
});
