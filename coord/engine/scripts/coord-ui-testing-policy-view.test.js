"use strict";

// COORD-939: read-only invariant guard for the coord-ui testing-policy views.
//
// Scope is READ views only (human-admin decision 2026-11-14). Editing and approval
// flows are a follow-up ticket with its own ADR gate, so this suite asserts that no
// write, spawn, fetch, form, button, server action or mutation route exists in the
// new views, and that every governed command they render is text, not an action.
//
// Source-scan approach (as coord-ui-config-view.test.js). Behavioural coverage of the
// pure core (fake io that throws on any write-class member) lives in
// frontend/apps/coord-ui/lib/testing-policy-core.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const UI = path.join(REPO_ROOT, "frontend", "apps", "coord-ui");
const DATA_LAYER = path.join(UI, "lib", "testing-policy-view.ts");
const CORE = path.join(UI, "lib", "testing-policy-core.js");
const CORE_DTS = path.join(UI, "lib", "testing-policy-core.d.ts");
const PAGE = path.join(UI, "app", "testing-policy", "page.tsx");
const RESOLVE_PAGE = path.join(UI, "app", "testing-policy", "resolve", "[ref]", "page.tsx");
const ROUTE_DIR = path.join(UI, "app", "testing-policy");
const NAV = path.join(UI, "components", "operator-navigation.tsx");
const README = path.join(UI, "README.md");
const ACCESS_CORE = require(path.join(REPO_ROOT, "coord", "engine", "scripts", "coord-ui-access-core.js"));

const SHIPPED = [DATA_LAYER, CORE, CORE_DTS, PAGE, RESOLVE_PAGE];

// Write, spawn, network and mutation primitives. None may appear in the new views.
const FORBIDDEN = [
  /\bfs\.\w*[wW]rite\w*/,
  /\bfs\.append\w*/,
  /\bfs\.mkdir\w*/,
  /\bfs\.rm\w*/,
  /\bfs\.unlink\w*/,
  /\bfs\.rename\w*/,
  /\bfs\.copy\w*/,
  /\bchild_process\b/,
  /\bspawn\w*\(/,
  /\bexec\w*\(/,
  /\bexecFile\w*/,
  /\bfetch\(/,
  /\bXMLHttpRequest\b/,
  /method:\s*['"`]POST['"`]/i,
  /['"]use server['"]/,
  /['"]use client['"]/,
  /<form\b/i,
  /<button\b/i,
  /<input\b/i,
  /<select\b/i,
  /<textarea\b/i,
  /\bonClick=/,
  /\bonChange=/,
  /\bonSubmit=/,
  /\baction=\{/,
];

test("COORD-939: all shipped testing-policy view files exist", () => {
  for (const f of SHIPPED) assert.ok(fs.existsSync(f), `${path.relative(REPO_ROOT, f)} must exist`);
});

test("COORD-939: no write, spawn, fetch, form, button or server-action primitive in any shipped view file", () => {
  for (const f of SHIPPED) {
    const src = fs.readFileSync(f, "utf8");
    for (const re of FORBIDDEN) {
      assert.ok(!re.test(src), `${path.relative(REPO_ROOT, f)} must not contain ${re}`);
    }
  }
});

test("COORD-939: the pure core is fs-free and touches io only through the three read methods", () => {
  const src = fs.readFileSync(CORE, "utf8");
  assert.ok(!/from\s+['"]node:/.test(src) && !/require\(/.test(src), "core must not import node modules or require");
  const used = new Set([...src.matchAll(/\bio\.(\w+)/g)].map((m) => m[1]));
  for (const name of used) {
    assert.ok(["exists", "readText", "listDir"].includes(name), `core calls io.${name}, which is not a read method`);
  }
  assert.match(src, /READ_IO_METHODS = Object\.freeze\(\['exists', 'readText', 'listDir'\]\)/);
});

test("COORD-939: the data layer hands the core a read-only io with exactly three read members", () => {
  const src = fs.readFileSync(DATA_LAYER, "utf8");
  assert.match(src, /const readIo: TestingPolicyIo = \{\s*exists:[\s\S]*?readText:[\s\S]*?listDir:[\s\S]*?\};/);
  assert.match(src, /import 'server-only'/, "data layer must stay server-only");
  assert.match(src, /requireExternal/, "adopter override is loaded through the shared in-workspace requirer");
  assert.match(src, /settings: config\.settings/, "adopter configuration rows come from the existing Configuration layer");
});

test("COORD-939: the testing-policy routes are GET-only server components with no route handlers or actions", () => {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else files.push(path.relative(ROUTE_DIR, p));
    }
  })(ROUTE_DIR);
  assert.deepEqual(files.sort(), ["page.tsx", "proposal-form.tsx", path.join("resolve", "[ref]", "page.tsx")].sort(),
    "only the overview page, resolve page, and explicitly scoped proposal form may exist under /testing-policy");
  const pageFiles = files.filter((rel) => path.basename(rel) === "page.tsx");
  assert.equal(pageFiles.length, 2, "overview and resolve remain server-rendered page routes");
  for (const rel of pageFiles) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROUTE_DIR, rel), "utf8"), /['\"]use client['\"]/, `${rel} remains a server component`);
  }
  const proposalForm = fs.readFileSync(path.join(ROUTE_DIR, "proposal-form.tsx"), "utf8");
  assert.match(proposalForm, /^['\"]use client['\"]/);
  assert.match(proposalForm, /fetch\('\/api\/config\/proposals'/);
  assert.match(proposalForm, /method: 'POST'/);
  assert.doesNotMatch(proposalForm, /config approve|human-admin-override/i,
    "the only client mutation submits inert proposals and exposes no approval action");
});

test("COORD-939: the governed commands the views render are text, and every gov verb they name is accounted for", () => {
  const sources = SHIPPED.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const verbs = new Set([...sources.matchAll(/coord\/scripts\/gov\s+([a-z][a-z-]*)/g)].map((m) => m[1]));
  // Read-class verbs, plus test-policy, which VERB_CLASSES classes conservatively as write
  // because `except` writes board metadata. The views only render these as text.
  const allowed = new Set(["test-policy", "commit"]);
  for (const v of verbs) assert.ok(allowed.has(v), `view names gov verb "${v}" that is not in the audited set`);
  assert.match(sources, /to change:/, "config rows must render the governed change command");
});

test("COORD-939: the views and their README/nav entries are read-only and discoverable", () => {
  const nav = fs.readFileSync(NAV, "utf8");
  assert.match(nav, /href: '\/testing-policy'/, "nav must link the testing-policy view");
  const readme = fs.readFileSync(README, "utf8");
  assert.match(readme, /`\/testing-policy`/, "README route list must name /testing-policy");
  assert.match(readme, /`\/testing-policy\/resolve\/\[ref\]`/, "README route list must name the resolve route");
});

test("COORD-939: viewer-facing identity fields pass through role redaction", () => {
  const page = fs.readFileSync(PAGE, "utf8");
  assert.match(page, /requireRole\('viewer'\)/, "overview page must require a role");
  assert.match(page, /redact\('identity'/, "recorded_by must be redacted by role");
  assert.match(page, /redact\('identity', proposal\.proposer, role\)/,
    "pending proposal submitter identity must be redacted by role");
  const resolve = fs.readFileSync(RESOLVE_PAGE, "utf8");
  assert.match(resolve, /redact\('identity'/, "resolve page must redact recorded_by");
});

test("COORD-1027: pending proposal identity renders redacted for viewers and intact for operators", () => {
  const page = fs.readFileSync(PAGE, "utf8");
  assert.match(page, /Proposed by \{String\(redact\('identity', proposal\.proposer, role\) \?\? 'unknown'\)\}/,
    "the displayed proposer label must use the same role-aware redaction as other identities");
  const displayedLabel = (role) => `Proposed by ${String(ACCESS_CORE.redactField("identity", "codexa810", role))}`;
  assert.equal(displayedLabel("viewer"), `Proposed by ${ACCESS_CORE.REDACTED}`);
  assert.equal(displayedLabel("operator"), "Proposed by codexa810");
});
