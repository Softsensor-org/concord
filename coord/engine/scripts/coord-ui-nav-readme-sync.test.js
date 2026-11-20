"use strict";

// COORD-110 / COORD-485: navigation <-> README route-list drift guard.
//
// The coord-ui README route list (frontend/apps/coord-ui/README.md) had drifted
// from the actual nav (frontend/apps/coord-ui/components/operator-navigation.tsx): it omitted the
// /quality, /dispatch, /runtime, /evidence, /cost views the nav exposes. Docs
// silently going stale relative to shipped routes is exactly the kind of drift
// governance is supposed to catch, so this test pins the two surfaces together.
//
// It reads both files via fs (no Next/TS runtime needed — this runs in the
// node:test coord suite which is the gate), parses:
//   - the NAV href set from the `const NAV = [ ... ]` array in operator-navigation.tsx, and
//   - the route-path set from the README "## Routes" bullet list,
// then asserts the README route list COVERS every nav entry (README >= nav).
// It also asserts every static nav route has a backing app/<route>/page.tsx,
// so the nav itself can't reference a non-existent route.
//
// Robust to formatting: it compares the SET of route paths, tolerates extra
// README-only routes (e.g. the dynamic /ticket/[id], which is intentionally not
// a top-level nav entry), and ignores bullet prose after the path token.
//
// Read-only: no board/runtime side effects.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const COORD_DIR = path.resolve(__dirname, "..", "..");
const PROJECT_ROOT = path.dirname(COORD_DIR);
const UI_DIR = path.join(PROJECT_ROOT, "frontend", "apps", "coord-ui");
const NAVIGATION_PATH = path.join(UI_DIR, "components", "operator-navigation.tsx");
const README_PATH = path.join(UI_DIR, "README.md");
const APP_DIR = path.join(UI_DIR, "app");

// --- parsers -----------------------------------------------------------------

// Pull every `href: '/...'` entry out of the `const NAV = [ ... ]` block.
function parseNavHrefs(layoutSource) {
  const navMatch = layoutSource.match(/const\s+NAV\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(navMatch, "could not locate the `const NAV = [...]` array in layout.tsx");
  const body = navMatch[1];
  const hrefs = [];
  const re = /href:\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    hrefs.push(m[1]);
  }
  return hrefs;
}

function parseNavItems(navigationSource) {
  const navMatch = navigationSource.match(/const\s+NAV\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(navMatch, "could not locate the `const NAV = [...]` array in operator-navigation.tsx");
  const entries = [];
  const re = /\{\s*href:\s*['"]([^'"]+)['"],\s*label:\s*['"]([^'"]+)['"],\s*group:\s*['"]([^'"]+)['"],\s*maturity:\s*['"]([^'"]+)['"]\s*\}/g;
  let match;
  while ((match = re.exec(navMatch[1])) !== null) {
    entries.push({ href: match[1], label: match[2], group: match[3], maturity: match[4] });
  }
  return entries;
}

// Pull the route path out of each bullet in the README "## Routes" section.
// Each route bullet starts with `- \`/...\``; the section ends at the next
// `## ` heading. We accept paths beginning with `/`.
function parseReadmeRoutes(readmeSource) {
  const start = readmeSource.indexOf("## Routes");
  assert.ok(start !== -1, "could not locate the `## Routes` section in README.md");
  const rest = readmeSource.slice(start + "## Routes".length);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);
  const routes = [];
  const re = /^\s*-\s*`(\/[^`]*)`/gm;
  let m;
  while ((m = re.exec(section)) !== null) {
    routes.push(m[1]);
  }
  return routes;
}

// A nav href is "static" (has a backing page dir) unless it is the root or a
// dynamic segment. We treat "/" specially and skip bracketed dynamic paths.
function navRouteDirs(hrefs) {
  return hrefs.filter((h) => h !== "/" && !h.includes("[")).map((h) => h.replace(/^\//, ""));
}

// --- tests -------------------------------------------------------------------

test("coord-ui README route list covers every nav entry (README >= nav)", () => {
  const navigation = fs.readFileSync(NAVIGATION_PATH, "utf8");
  const readme = fs.readFileSync(README_PATH, "utf8");

  const navHrefs = new Set(parseNavHrefs(navigation));
  const readmeRoutes = new Set(parseReadmeRoutes(readme));

  assert.ok(navHrefs.size > 0, "parsed zero nav hrefs — parser or layout broke");
  assert.ok(readmeRoutes.size > 0, "parsed zero README routes — parser or README broke");

  const missingFromReadme = [...navHrefs].filter((h) => !readmeRoutes.has(h)).sort();
  assert.deepEqual(
    missingFromReadme,
    [],
    `README route list is stale: nav exposes routes the README omits: ${missingFromReadme.join(", ")}`
  );
});

test("every static coord-ui nav route resolves to an app/<route>/page.tsx", () => {
  const navigation = fs.readFileSync(NAVIGATION_PATH, "utf8");
  const hrefs = parseNavHrefs(navigation);

  // root route
  assert.ok(
    fs.existsSync(path.join(APP_DIR, "page.tsx")),
    "missing app/page.tsx for the `/` nav route"
  );

  const missingPages = navRouteDirs(hrefs).filter(
    (dir) => !fs.existsSync(path.join(APP_DIR, dir, "page.tsx"))
  );
  assert.deepEqual(
    missingPages,
    [],
    `nav references routes with no backing page.tsx: ${missingPages.join(", ")}`
  );
});

test("default navigation is the stable operator loop and advanced mode retains all views", () => {
  const navigation = fs.readFileSync(NAVIGATION_PATH, "utf8");
  const items = parseNavItems(navigation);
  assert.ok(items.length > 0, "parsed zero navigation items with maturity metadata");
  assert.equal(new Set(items.map((item) => item.href)).size, items.length, "navigation contains duplicate routes");
  assert.deepEqual(
    items.filter((item) => item.maturity === "stable").map((item) => item.href),
    ["/", "/dispatch", "/pipeline", "/gates", "/tests", "/evidence", "/onboarding", "/readiness", "/health"]
  );
  assert.ok(items.filter((item) => item.maturity === "advanced").length > 0);
  assert.ok(items.every((item) => ["stable", "advanced"].includes(item.maturity)));
});
