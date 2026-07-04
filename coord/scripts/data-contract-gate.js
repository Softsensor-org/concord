"use strict";

// COORD-191: data-contract gate-proc for the DATA & ANALYTICS track.
//
// Modeled on the prior data-platform build: a data/analytics ticket gates on
// DATA-CONTRACT CERTIFICATION, not a test suite. Each certified
// analytical product declares a contract (grain, key, currency, tests) in a
// registry; this gate runs hard-fail data-quality checks — currency-suffix,
// reconciles_to tolerance, baseline_metric
// band, key-coverage, period identity, no-duplicate-key, required-columns — plus
// two lifecycle invariants: a certified product may only consume certified
// products, and no superseded product may feed a certified one.
//
// PURE NODE, ZERO DEPS. The core evaluator works on a structured registry object
// (the machine-readable form of the scaffold's pipeline.yml + measured "facts");
// the CLI reads that registry as JSON. See
// coord/profiles/data-analytics/ for the authoring scaffold and
// coord/product/MULTI_TRACK_GOVERNANCE_PROFILE.md for how this fits the track.
//
// Report shape matches the other track gate-procs (analytics-gate.js, etc.).

const fs = require("fs");
const path = require("path");

// approxWithin: is |value - target| within a ratio tolerance of target?
function approxWithin(value, target, toleranceRatio) {
  const allow = Math.abs(target) * (toleranceRatio || 0);
  return Math.abs(value - target) <= allow;
}

// rowCountWithinTolerance: is `actual` within the declared band around the
// pre-run `baseline`? COORD-195: the band is the UNION of a ratio tolerance
// (% of baseline) and an absolute tolerance — mirroring how reconciles_to
// expresses tolerance, but additionally allowing an absolute floor so a
// 0-row baseline (a fresh backfill) can still declare a meaningful band.
// At least one of the two tolerances must be declared by the caller.
function rowCountWithinTolerance(actual, baseline, { tolerance, tolerance_abs } = {}) {
  const ratioAllow = Math.abs(baseline) * (tolerance || 0);
  const absAllow = tolerance_abs || 0;
  const allow = Math.max(ratioAllow, absAllow);
  return Math.abs(actual - baseline) <= allow;
}

// evaluateContracts(registry) -> report
// registry = {
//   id?: string,
//   superseded?: [productId],
//   products: [{
//     id, certified?, inputs?: [id|sourceRef], outputs?: [file],
//     tests?: { row_count_positive?, required_columns?: [..], no_duplicate_key?,
//               currency_suffix?, currency_exempt?: [..],
//               reconciles_to?: { to, tolerance },
//               reconciles_to_row_count?: { baseline, tolerance?, tolerance_abs? },
//               baseline_metric?: { metric, min, max },
//               key_coverage_with?: { other, ratio }, period? },
//     facts?: { row_count, columns: [..], duplicate_keys, currency_columns: [..],
//               sum, post_row_count, baseline_metric_value, key_coverage_ratio, period },
//   }],
// }
function evaluateContracts(registry) {
  const products = (registry && registry.products) || [];
  const superseded = new Set((registry && registry.superseded) || []);
  const productIds = new Set(products.map((p) => p.id));
  const certifiedIds = new Set(products.filter((p) => p.certified).map((p) => p.id));
  const checks = [];
  const artifactPaths = [];

  for (const p of products) {
    const t = p.tests || {};
    const f = p.facts || {};
    const add = (name, result, detail) =>
      checks.push({ name: `product[${p.id}]:${name}`, result, detail });

    if (Array.isArray(p.outputs)) artifactPaths.push(...p.outputs);

    // --- hard-fail data-quality checks (only when declared + facts present) ---
    if (t.row_count_positive && f.row_count !== undefined) {
      add("row_count_positive", f.row_count > 0 ? "pass" : "fail", `row_count=${f.row_count}`);
    }
    if (Array.isArray(t.required_columns)) {
      const cols = f.columns || [];
      const missing = t.required_columns.filter((c) => !cols.includes(c));
      add(
        "required_columns",
        missing.length === 0 ? "pass" : "fail",
        missing.length ? `missing: ${missing.join(", ")}` : "all present"
      );
    }
    if (t.no_duplicate_key && f.duplicate_keys !== undefined) {
      add("no_duplicate_key", f.duplicate_keys === 0 ? "pass" : "fail", `duplicate_keys=${f.duplicate_keys}`);
    }
    if (t.currency_suffix && f.currency_columns !== undefined) {
      const exempt = new Set(t.currency_exempt || []);
      const bad = (f.currency_columns || []).filter((c) => !exempt.has(c) && !/_(sar|usd)$/i.test(c));
      add(
        "currency_suffix",
        bad.length === 0 ? "pass" : "fail",
        bad.length ? `monetary columns without _sar/_usd suffix: ${bad.join(", ")}` : "ok"
      );
    }
    if (t.reconciles_to && f.sum !== undefined) {
      const target = t.reconciles_to.to;
      const tol = t.reconciles_to.tolerance || 0;
      const ok = approxWithin(f.sum, target, tol);
      add(
        "reconciles_to",
        ok ? "pass" : "fail",
        `sum=${f.sum} vs ${target} (±${tol * 100}%) diff=${Math.abs(f.sum - target)}`
      );
    }
    // COORD-195: row-count-delta / before-after reconcile (data-backfill proof).
    // This is the ONE assertion that hard-fails on an ABSENT post-run fact: when
    // a contract declares reconciles_to_row_count it is asserting "I have proven
    // the post-run row count lands within tolerance of the pre-run baseline",
    // so a missing post-run count is itself a failure (the proof was not run).
    // Optional: contracts that do not declare it are completely unaffected.
    if (t.reconciles_to_row_count) {
      const decl = t.reconciles_to_row_count;
      const baseline = decl.baseline;
      // Post-run count: prefer an explicit post_row_count fact, else the
      // standard measured row_count fact.
      const post = f.post_row_count !== undefined ? f.post_row_count : f.row_count;
      const tol = decl.tolerance || 0;
      const tolAbs = decl.tolerance_abs || 0;
      const band =
        tolAbs > 0
          ? `±max(${tol * 100}%, ${tolAbs} rows)`
          : `±${tol * 100}%`;
      if (post === undefined || post === null) {
        add(
          "reconciles_to_row_count",
          "fail",
          `post-run row count absent (baseline=${baseline}, band=${band}); ` +
            `data-backfill before/after proof was not produced`
        );
      } else if (baseline === undefined || baseline === null) {
        add(
          "reconciles_to_row_count",
          "fail",
          `reconciles_to_row_count declares no pre-run baseline (post=${post})`
        );
      } else {
        const ok = rowCountWithinTolerance(post, baseline, { tolerance: tol, tolerance_abs: tolAbs });
        add(
          "reconciles_to_row_count",
          ok ? "pass" : "fail",
          `post-run row_count=${post} vs baseline=${baseline} (${band}) ` +
            `delta=${post - baseline}`
        );
      }
    }
    if (t.baseline_metric && f.baseline_metric_value !== undefined) {
      const { min, max, metric } = t.baseline_metric;
      const v = f.baseline_metric_value;
      const ok = (min === undefined || v >= min) && (max === undefined || v <= max);
      add("baseline_metric", ok ? "pass" : "fail", `${metric || "metric"}=${v} band=[${min}, ${max}]`);
    }
    if (t.key_coverage_with && f.key_coverage_ratio !== undefined) {
      const need = t.key_coverage_with.ratio;
      add(
        "key_coverage_with",
        f.key_coverage_ratio >= need ? "pass" : "fail",
        `coverage=${f.key_coverage_ratio} need>=${need} (vs ${t.key_coverage_with.other || "?"})`
      );
    }
    if (t.period !== undefined && f.period !== undefined) {
      add("period_identity", f.period === t.period ? "pass" : "fail", `period=${f.period} expected=${t.period}`);
    }

    // --- lifecycle invariants for certified products ---
    if (p.certified) {
      const inputs = p.inputs || [];
      // certified may only consume certified PRODUCTS (raw sources not in the
      // registry are allowed and ignored).
      const nonCert = inputs.filter((i) => productIds.has(i) && !certifiedIds.has(i));
      add(
        "certified_inputs",
        nonCert.length === 0 ? "pass" : "fail",
        nonCert.length ? `certified product consumes non-certified product(s): ${nonCert.join(", ")}` : "ok"
      );
      const fromSuperseded = inputs.filter((i) => superseded.has(i));
      add(
        "no_superseded_feed",
        fromSuperseded.length === 0 ? "pass" : "fail",
        fromSuperseded.length ? `fed by superseded product(s): ${fromSuperseded.join(", ")}` : "ok"
      );
    }
  }

  const failed = checks.filter((c) => c.result === "fail");
  return {
    gateProc: "data-contract",
    track: "data-analytics",
    target: (registry && registry.id) || "registry",
    result: failed.length === 0 ? "pass" : "fail",
    checks,
    artifact_paths: artifactPaths,
    summary:
      failed.length === 0
        ? `data-contract gate pass: ${checks.length} check(s) ok across ${products.length} product(s)`
        : `data-contract gate fail: ${failed.length}/${checks.length} check(s) failed`,
  };
}

function loadRegistry(registryPath) {
  const raw = fs.readFileSync(registryPath, "utf8");
  return JSON.parse(raw);
}

function runDataContractGate(options = {}) {
  const registry = options.registry || loadRegistry(options.registryPath);
  return evaluateContracts(registry);
}

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--registry") out.registryPath = argv[++i];
    else if (!out.registryPath && !a.startsWith("--")) out.registryPath = a;
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.registryPath) {
    process.stderr.write("usage: node data-contract-gate.js <registry.json> [--json]\n");
    process.exit(2);
  }
  const report = runDataContractGate({ registryPath: path.resolve(args.registryPath) });
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`${report.summary}\n`);
    for (const c of report.checks) {
      if (c.result === "fail") process.stdout.write(`  [${c.result}] ${c.name}: ${c.detail}\n`);
    }
  }
  process.exit(report.result === "pass" ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateContracts,
  loadRegistry,
  runDataContractGate,
  approxWithin,
  rowCountWithinTolerance,
  main,
};
