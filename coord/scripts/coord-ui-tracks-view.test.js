"use strict";

// COORD-414: /tracks must mirror the canonical multi-track registry and
// evidence policy. It is a read-only view; it must not run gates or mutate
// governance state from the web tier.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI = path.join(REPO_ROOT, "frontend", "apps", "coord-ui");
const LIB = path.join(UI, "lib", "tracks.ts");
const PAGE = path.join(UI, "app", "tracks", "page.tsx");
const LAYOUT = path.join(UI, "app", "layout.tsx");
const README = path.join(UI, "README.md");

test("coord-ui /tracks loader mirrors canonical track sources", () => {
  const src = fs.readFileSync(LIB, "utf8");
  for (const literal of [
    "track-registry.js",
    "track-evidence-policy.js",
    "track-evidence-policy.json",
    "data-contract-gate.js",
    "analytics-gate.js",
    "requireExternal",
  ]) {
    assert.match(src, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `tracks loader must reference ${literal}`);
  }
});

test("coord-ui /tracks renders built-in tracks and data profile", () => {
  const page = fs.readFileSync(PAGE, "utf8");
  for (const literal of [
    "Multi-track governance profile",
    "Data analytics profile",
    "Bootstrap/backfill overlay",
    "dataAnalytics",
    "qualityChecks",
    "lifecycleInvariants",
  ]) {
    assert.match(page, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `tracks page must render ${literal}`);
  }
  const lib = fs.readFileSync(LIB, "utf8");
  for (const literal of [
    "row_count_positive",
    "required_columns",
    "no_duplicate_key",
    "currency_suffix",
    "reconciles_to",
    "reconciles_to_row_count",
    "baseline_metric",
    "certified_inputs",
    "no_superseded_feed",
  ]) {
    assert.match(lib, new RegExp(literal), `data analytics profile must include ${literal}`);
  }
});

test("coord-ui /tracks is wired into nav and README", () => {
  assert.match(fs.readFileSync(LAYOUT, "utf8"), /href:\s*'\/tracks'/);
  assert.match(fs.readFileSync(README, "utf8"), /`\/tracks`/);
});

test("coord-ui /tracks remains read-only", () => {
  const lib = fs.readFileSync(LIB, "utf8");
  const page = fs.readFileSync(PAGE, "utf8");
  for (const src of [lib, page]) {
    for (const re of [
      /\bchild_process\b/,
      /\bspawn\w*\(/,
      /\bexec\w*\(/,
      /\bfs\.\w*[wW]rite\w*/,
      /\bfs\.append\w*/,
      /\bfs\.mkdir\w*/,
      /\bfs\.rm\w*/,
      /<form\b/i,
      /<button\b/i,
      /onClick=/,
      /onSubmit=/,
    ]) {
      assert.ok(!re.test(src), `tracks view must not contain mutation/execution surface matching ${re}`);
    }
  }
});
