"use strict";

// COORD-411: /requirements/[slug] exposes every contract-named requirements
// cockpit view as a read-only drill-down. It must render source status and
// copyable commands without running any generator from the web tier.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI = path.join(REPO_ROOT, "frontend", "apps", "coord-ui");
const ENGINE = require("./requirements-cockpit-model.js");
const LIB = path.join(UI, "lib", "requirements.ts");
const INDEX = path.join(UI, "app", "requirements", "page.tsx");
const DETAIL = path.join(UI, "app", "requirements", "[slug]", "page.tsx");

test("requirements cockpit exposes the 13 contract-named detail routes", () => {
  const routes = ENGINE.VIEW_DEFS.map((v) => v.route).sort();
  assert.equal(routes.length, 13);
  for (const expected of [
    "/requirements/sources",
    "/requirements/conformance",
    "/requirements/surfaces",
    "/requirements/domain-boundary",
    "/requirements/workflows",
    "/requirements/donor-reuse",
    "/requirements/deviations-waivers",
    "/requirements/controlled-documents",
    "/requirements/sequencing",
    "/requirements/stale-impact",
  ]) {
    assert.ok(routes.includes(expected), `missing ${expected}`);
  }
});

test("coord-ui requirements detail route exists and renders source status", () => {
  assert.ok(fs.existsSync(LIB), "lib/requirements.ts must exist");
  assert.ok(fs.existsSync(INDEX), "requirements index page must exist");
  assert.ok(fs.existsSync(DETAIL), "requirements/[slug] page must exist");
  const lib = fs.readFileSync(LIB, "utf8");
  const page = fs.readFileSync(DETAIL, "utf8");
  assert.match(lib, /source_status/, "loader must expose per-source artifact status");
  assert.match(lib, /slugForRequirementRoute/, "loader must provide stable route slugging");
  assert.match(page, /loadRequirementView/, "detail page must load one engine-defined view");
  assert.match(page, /view\.copy_command/, "detail page must render the copyable command");
  assert.match(page, /source\.exists/, "detail page must render source availability");
});

test("requirements detail page remains read-only", () => {
  const page = fs.readFileSync(DETAIL, "utf8");
  for (const re of [/'use client'/, /<form\b/i, /<button\b/i, /<input\b/i, /onClick=/, /onSubmit=/, /\bfetch\(/]) {
    assert.ok(!re.test(page), `requirements detail page must not contain mutation surface matching ${re}`);
  }
  const lib = fs.readFileSync(LIB, "utf8");
  for (const re of [/\bfs\.\w*[wW]rite\w*/, /\bchild_process\b/, /\bspawn\w*\(/, /\bexec\w*\(/]) {
    assert.ok(!re.test(lib), `requirements loader must not contain mutation/spawn surface matching ${re}`);
  }
});
