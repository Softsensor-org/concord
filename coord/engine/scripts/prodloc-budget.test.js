"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
// COORD-957: the one production-LOC budget check. Both the arch-checks gate and the closeout guard
// must decide through prodloc-budget.js; these tests fail without that merged module.
const budget = require("./prodloc-budget.js");
const { checkProductionModuleLocBudget, DEFAULT_CONFIG } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/arch-checks.js"));
const harness = require("./__fixtures__/prodloc-budget-harness.js");
const fixture = require("./__fixtures__/prodloc-budget-equivalence.json");

const mkLines = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";

test("COORD-957: every recorded production-LOC refusal and admission reproduces field for field", () => {
  const now = harness.runCases();
  assert.equal(now.length, fixture.cases.length, "the case list matches the recorded equivalence fixture");
  for (let i = 0; i < fixture.cases.length; i += 1) {
    assert.equal(now[i].name, fixture.cases[i].name);
    assert.deepEqual(now[i].outcome, fixture.cases[i].outcome, `equivalence: ${fixture.cases[i].name}`);
  }
});

test("COORD-957: the equivalence fixture enumerates every refusal the two old guards could make", () => {
  const refused = fixture.cases.map((c) => (c.outcome.refused || "")).join("\n");
  const findings = fixture.cases.flatMap((c) => c.outcome.findings || []);
  const expectations = [
    [/prodloc closeout refused: .*: measured \d+ LOC, declared budget \d+/, "measured past the declared budget"],
    [/must be a regular production source file, not a link/, "production source link"],
    [/budget raised: .* a candidate may not raise a budget/, "candidate raised a budget"],
    [/budget carried by a move from /, "carried budget exceeded"],
    [/budget invented for unregistered path/, "candidate-invented budget"],
    [/coord\/engine\/scripts\/budget-engine-fixture\.js: measured 1201 LOC/, "engine-scripts module (COORD-871)"],
  ];
  for (const [pattern, label] of expectations) assert.match(refused, pattern, `old closeout refusal still covered: ${label}`);
  assert.ok(findings.some((f) => f.check === "prodloc" && /grew past its production-module high-water LOC budget/.test(f.message)),
    "old arch-checks prodloc finding still covered");
  assert.ok(fixture.cases.some((c) => c.outcome.admitted && c.name.includes("admitted")), "admissions are recorded too");
});

// COORD-378, COORD-395: growth past a high-water budget is refused at the arch gate and at closeout.
test("COORD-378/COORD-395: growth past a high-water budget is refused by the one budget check", () => {
  const config = { maxLoc: 1200, severity: "fail", include: ["coord/scripts/"], highWater: { "coord/scripts/legacy.js": 10 } };
  const hit = budget.productionLocExcess({ file: "coord/scripts/legacy.js", source: mkLines(11), config });
  assert.deepEqual(hit && { loc: hit.loc, budget: hit.budget }, { loc: 11, budget: 10 });
  assert.equal(budget.productionLocExcess({ file: "coord/scripts/legacy.js", source: mkLines(10), config }), null);
  const gate = checkProductionModuleLocBudget({ file: "coord/scripts/legacy.js", source: mkLines(11), config, severity: "fail" });
  assert.equal(gate.length, 1);
  assert.equal(gate[0].threshold, hit.budget);
});

// COORD-913: a trusted budget follows a move only through a registered move; the carry is recorded.
test("COORD-913: budgetFor applies a carried legacy budget to its registered move and default elsewhere", () => {
  const trusted = { "coord/scripts/legacy.js": 1500 };
  const carried = new Map([["coord/engine/scripts/moved.js", { from: "coord/scripts/legacy.js", kind: "registered shim" }]]);
  assert.deepEqual(budget.budgetFor("coord/engine/scripts/moved.js", { trusted, maxLoc: 1200, carried }),
    { budget: 1500, carry: carried.get("coord/engine/scripts/moved.js") });
  assert.deepEqual(budget.budgetFor("coord/engine/scripts/other.js", { trusted, maxLoc: 1200, carried }), { budget: 1200, carry: null });
});

// COORD-871: combined branches are measured at closeout against the same budget the gate uses.
test("COORD-871: the arch gate and closeout share one budget decision for an engine-scripts module", () => {
  const cfg = DEFAULT_CONFIG.checks.prodloc;
  const file = "coord/engine/scripts/new-engine-module.js";
  const source = mkLines(cfg.maxLoc + 1);
  const shared = budget.productionLocExcess({ file, source, config: cfg });
  const gate = checkProductionModuleLocBudget({ file, source, config: cfg, severity: "fail" });
  assert.equal(shared.budget, cfg.maxLoc);
  assert.equal(gate[0].threshold, shared.budget, "gate and closeout share the threshold");
  assert.equal(gate[0].value, shared.loc);
  assert.equal(budget.productionLocExcess({ file: "coord/engine/scripts/new-engine-module.test.js", source, config: cfg }), null);
});

test("COORD-957: the shared module keeps the trusted-budget and path helpers used by both guards", () => {
  assert.equal(budget.normalizeFindingFilePath("./coord\\scripts\\x.js"), "coord/scripts/x.js");
  assert.equal(budget.normalizeFindingFilePath(null), "");
  assert.deepEqual(budget.countLoc(null), { loc: 0, total: 0 });
  assert.equal(budget.shouldCheckProductionModuleLoc("coord/scripts/x.js", DEFAULT_CONFIG.checks.prodloc), true);
  assert.equal(budget.countLoc("const a = 1;\n// comment\n\n").loc, 1);
  assert.equal(fs.existsSync(path.join(__dirname, "prodloc-budget.js")), true);
});
