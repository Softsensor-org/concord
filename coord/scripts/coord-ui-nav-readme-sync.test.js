"use strict";

// COORD-110: nav <-> README route-list drift guard for the coord-ui cockpit.
//
// The coord-ui README route list (frontend/apps/coord-ui/README.md) had drifted
// from the actual nav (frontend/apps/coord-ui/app/layout.tsx): it omitted the
// /quality, /dispatch, /runtime, /evidence, /cost views the nav exposes. Docs
// silently going stale relative to shipped routes is exactly the kind of drift
// governance is supposed to catch, so this test pins the two surfaces together.
//
// It reads both files via fs (no Next/TS runtime needed — this runs in the
// node:test coord suite which is the gate), parses:
//   - the NAV href set from the `const NAV = [ ... ]` array in layout.tsx, and
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

const COORD_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.dirname(COORD_DIR);
const UI_DIR = path.join(PROJECT_ROOT, "frontend", "apps", "coord-ui");
const LAYOUT_PATH = path.join(UI_DIR, "app", "layout.tsx");
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
  const layout = fs.readFileSync(LAYOUT_PATH, "utf8");
  const readme = fs.readFileSync(README_PATH, "utf8");

  const navHrefs = new Set(parseNavHrefs(layout));
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
  const layout = fs.readFileSync(LAYOUT_PATH, "utf8");
  const hrefs = parseNavHrefs(layout);

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
