"use strict";

// COORD-261: read-only invariant guard for the coord-ui Readiness cockpit.
//
// The readiness page must consume the generated coord doctor artifact, not
// reimplement or execute readiness scanning from the web request path.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI = path.join(REPO_ROOT, "frontend", "apps", "coord-ui");
const LIB = path.join(UI, "lib", "readiness.ts");
const PAGE = path.join(UI, "app", "readiness", "page.tsx");
const LAYOUT = path.join(UI, "app", "layout.tsx");
const README = path.join(UI, "README.md");
const CONTRACT = path.join(REPO_ROOT, "coord", "product", "COORD_UI_CONTRACT.md");

const FORBIDDEN_LIB = [
  /\bfs\.\w*[wW]rite\w*/,
  /\bfs\.append\w*/,
  /\bfs\.mkdir\w*/,
  /\bfs\.rm\w*/,
  /\bfs\.unlink\w*/,
  /\bfs\.rename\w*/,
  /\bchild_process\b/,
  /\bspawn\w*\(/,
  /\bexec\w*\(/,
  /\bexecFile\w*/,
  /readiness-doctor/,
  /createReadinessDoctor/,
];

test("readiness data layer is artifact-backed and read-only", () => {
  assert.ok(fs.existsSync(LIB), "lib/readiness.ts must exist");
  const src = fs.readFileSync(LIB, "utf8");
  for (const re of FORBIDDEN_LIB) {
    assert.ok(!re.test(src), `readiness.ts must not contain a scanner/mutation primitive matching ${re}`);
  }
  assert.match(src, /READINESS_REPORT_PATH/, "readiness view must read the generated artifact path");
  assert.match(src, /readOnly:\s*true/, "readiness view must mark itself read-only");
  assert.match(src, /enterpriseReadyClaim:\s*false/, "readiness view must not claim enterprise readiness");
  assert.match(src, /coord doctor --dir \. --json --output coord\/\.runtime\/readiness-report\.json/);
});

test("readiness page is server-only display with no mutation controls", () => {
  assert.ok(fs.existsSync(PAGE), "app/readiness/page.tsx must exist");
  const src = fs.readFileSync(PAGE, "utf8");
  for (const re of [
    /<form\b/i,
    /<button\b/i,
    /<input\b/i,
    /onClick=/,
    /onChange=/,
    /onSubmit=/,
    /\bfetch\(/,
    /method:\s*['"`]POST['"`]/i,
    /'use client'/,
  ]) {
    assert.ok(!re.test(src), `readiness page must not contain a mutation surface matching ${re}`);
  }
  assert.match(src, /loadReadinessView/, "page must source from the read-only data layer");
  assert.match(src, /Pilot vs Enterprise Blockers/, "page must split pilot and enterprise blockers");
});

test("readiness route is present in nav, README, and UI contract", () => {
  assert.match(fs.readFileSync(LAYOUT, "utf8"), /href:\s*'\/readiness'/);
  assert.match(fs.readFileSync(README, "utf8"), /`\/readiness`/);
  const contract = fs.readFileSync(CONTRACT, "utf8");
  assert.match(contract, /\| `\/readiness` \|/);
  assert.match(contract, /must not claim enterprise readiness/i);
});
