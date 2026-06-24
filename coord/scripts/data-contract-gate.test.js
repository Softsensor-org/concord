"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { evaluateContracts, approxWithin, rowCountWithinTolerance } = require("./data-contract-gate.js");

function cleanRegistry() {
  return {
    id: "demo",
    superseded: [],
    products: [
      {
        id: "sales_fact",
        certified: true,
        inputs: [],
        outputs: ["outputs/sales_fact.csv"],
        tests: {
          row_count_positive: true,
          required_columns: ["customer_id", "gross_sar"],
          no_duplicate_key: true,
          currency_suffix: true,
          reconciles_to: { to: 1000, tolerance: 0.05 },
          baseline_metric: { metric: "auc", min: 0.7, max: 0.8 },
          key_coverage_with: { other: "customer_dim", ratio: 0.95 },
          period: "Q1_2026",
        },
        facts: {
          row_count: 42,
          columns: ["customer_id", "gross_sar"],
          duplicate_keys: 0,
          currency_columns: ["gross_sar"],
          sum: 1010,
          baseline_metric_value: 0.75,
          key_coverage_ratio: 0.97,
          period: "Q1_2026",
        },
      },
    ],
  };
}

test("clean registry passes all checks", () => {
  const r = evaluateContracts(cleanRegistry());
  assert.strictEqual(r.result, "pass", JSON.stringify(r.checks.filter((c) => c.result === "fail")));
  assert.strictEqual(r.gateProc, "data-contract");
  assert.strictEqual(r.track, "data-analytics");
  assert.ok(r.artifact_paths.includes("outputs/sales_fact.csv"));
});

test("currency column without _sar/_usd suffix hard-fails", () => {
  const reg = cleanRegistry();
  reg.products[0].facts.currency_columns = ["gross"]; // missing suffix
  const r = evaluateContracts(reg);
  assert.strictEqual(r.result, "fail");
  assert.ok(r.checks.find((c) => c.name.endsWith(":currency_suffix") && c.result === "fail"));
});

test("reconcile outside tolerance hard-fails, inside passes", () => {
  const reg = cleanRegistry();
  reg.products[0].facts.sum = 1100; // 10% off, tolerance 5%
  assert.strictEqual(evaluateContracts(reg).result, "fail");
  reg.products[0].facts.sum = 1040; // 4% off
  assert.strictEqual(evaluateContracts(reg).result, "pass");
});

test("baseline metric out of band hard-fails", () => {
  const reg = cleanRegistry();
  reg.products[0].facts.baseline_metric_value = 0.65; // below min 0.7
  const r = evaluateContracts(reg);
  assert.ok(r.checks.find((c) => c.name.endsWith(":baseline_metric") && c.result === "fail"));
});

test("key coverage below required ratio hard-fails", () => {
  const reg = cleanRegistry();
  reg.products[0].facts.key_coverage_ratio = 0.5;
  assert.strictEqual(evaluateContracts(reg).result, "fail");
});

test("missing required column + duplicate keys + period drift each fail", () => {
  const reg = cleanRegistry();
  reg.products[0].facts.columns = ["customer_id"]; // missing gross_sar
  reg.products[0].facts.duplicate_keys = 3;
  reg.products[0].facts.period = "Q2_2026";
  const r = evaluateContracts(reg);
  const names = r.checks.filter((c) => c.result === "fail").map((c) => c.name);
  assert.ok(names.some((n) => n.endsWith(":required_columns")));
  assert.ok(names.some((n) => n.endsWith(":no_duplicate_key")));
  assert.ok(names.some((n) => n.endsWith(":period_identity")));
});

test("certified product consuming a non-certified product fails certified_inputs", () => {
  const reg = cleanRegistry();
  reg.products.push({ id: "scratch", certified: false, tests: {}, facts: {} });
  reg.products[0].inputs = ["scratch"];
  const r = evaluateContracts(reg);
  assert.ok(r.checks.find((c) => c.name === "product[sales_fact]:certified_inputs" && c.result === "fail"));
});

test("superseded product feeding a certified product fails no_superseded_feed", () => {
  const reg = cleanRegistry();
  reg.superseded = ["old_fact"];
  reg.products[0].inputs = ["old_fact"];
  const r = evaluateContracts(reg);
  assert.ok(r.checks.find((c) => c.name === "product[sales_fact]:no_superseded_feed" && c.result === "fail"));
});

test("raw source inputs (not in registry) do not trip certified_inputs", () => {
  const reg = cleanRegistry();
  reg.products[0].inputs = ["raw/source.xlsx"]; // not a registry product
  const r = evaluateContracts(reg);
  assert.strictEqual(r.result, "pass");
});

test("approxWithin tolerance helper", () => {
  assert.ok(approxWithin(105, 100, 0.05));
  assert.ok(!approxWithin(106, 100, 0.05));
});

// --- COORD-195: reconciles_to_row_count (before/after row-count proof) ---

// A registry that DECLARES the row-count-delta assertion. The clean shape is a
// 1000-row baseline reseeded to 1010 rows (1% delta) under a 5% tolerance.
function rowCountRegistry() {
  const reg = cleanRegistry();
  reg.products[0].tests.reconciles_to_row_count = { baseline: 1000, tolerance: 0.05 };
  reg.products[0].facts.post_row_count = 1010;
  return reg;
}

test("reconciles_to_row_count within tolerance passes", () => {
  const r = evaluateContracts(rowCountRegistry());
  assert.strictEqual(r.result, "pass", JSON.stringify(r.checks.filter((c) => c.result === "fail")));
  assert.ok(r.checks.find((c) => c.name.endsWith(":reconciles_to_row_count") && c.result === "pass"));
});

test("reconciles_to_row_count out of tolerance hard-fails with actionable message", () => {
  const reg = rowCountRegistry();
  reg.products[0].facts.post_row_count = 1200; // 20% above baseline, tolerance 5%
  const r = evaluateContracts(reg);
  assert.strictEqual(r.result, "fail");
  const check = r.checks.find((c) => c.name === "product[sales_fact]:reconciles_to_row_count");
  assert.strictEqual(check.result, "fail");
  // names the output, expected baseline, and actual post-run count
  assert.ok(check.name.includes("sales_fact"));
  assert.ok(check.detail.includes("post-run row_count=1200"));
  assert.ok(check.detail.includes("baseline=1000"));
});

test("reconciles_to_row_count with absent post-run count hard-fails (proof not produced)", () => {
  const reg = rowCountRegistry();
  delete reg.products[0].facts.post_row_count;
  delete reg.products[0].facts.row_count; // no measured row count at all
  const r = evaluateContracts(reg);
  assert.strictEqual(r.result, "fail");
  const check = r.checks.find((c) => c.name === "product[sales_fact]:reconciles_to_row_count");
  assert.strictEqual(check.result, "fail");
  assert.ok(check.detail.includes("absent"));
});

test("reconciles_to_row_count falls back to the standard row_count fact when no post_row_count", () => {
  const reg = rowCountRegistry();
  delete reg.products[0].facts.post_row_count;
  reg.products[0].facts.row_count = 1010; // standard measured fact, within band
  const r = evaluateContracts(reg);
  assert.strictEqual(r.result, "pass", JSON.stringify(r.checks.filter((c) => c.result === "fail")));
});

test("absolute tolerance band allows a small delta off a zero baseline (fresh backfill)", () => {
  const reg = cleanRegistry();
  reg.products[0].tests.reconciles_to_row_count = { baseline: 0, tolerance: 0.05, tolerance_abs: 50 };
  reg.products[0].facts.post_row_count = 40; // ratio band would be 0; abs band of 50 saves it
  assert.strictEqual(evaluateContracts(reg).result, "pass");
  reg.products[0].facts.post_row_count = 60; // outside the 50-row abs band
  assert.strictEqual(evaluateContracts(reg).result, "fail");
});

test("contract that does NOT declare reconciles_to_row_count is unaffected (optional)", () => {
  // cleanRegistry never declares the assertion; it must still pass and emit no
  // reconciles_to_row_count check at all.
  const r = evaluateContracts(cleanRegistry());
  assert.strictEqual(r.result, "pass");
  assert.ok(!r.checks.find((c) => c.name.endsWith(":reconciles_to_row_count")));
});

test("rowCountWithinTolerance helper (ratio + absolute union)", () => {
  assert.ok(rowCountWithinTolerance(1050, 1000, { tolerance: 0.05 })); // 5% exactly
  assert.ok(!rowCountWithinTolerance(1051, 1000, { tolerance: 0.05 }));
  assert.ok(rowCountWithinTolerance(40, 0, { tolerance: 0.05, tolerance_abs: 50 })); // abs floor
  assert.ok(!rowCountWithinTolerance(51, 0, { tolerance: 0.05, tolerance_abs: 50 }));
});
