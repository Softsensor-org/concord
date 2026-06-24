"use strict";

// COORD-150: read-only invariant guard for the coord-ui Configuration view.
//
// The Configuration cockpit view (app/configuration/page.tsx) + its data layer
// (lib/config-view.ts) surface the CURRENT config-as-code and the GOVERNED
// COMMAND to change each setting. The HARD constraint (coord/docs/
// MEMORY_ARCHITECTURE.md sec 12; SEC-001/SEC-002) is that this surface is
// STRICTLY READ-ONLY: it must NOT mutate config, toggle anything, write, spawn,
// or POST. Changing config is config-as-code on the governed lane (edit + commit).
//
// This suite reads the TS source as text (the same source-scanning approach
// coord-ui-command-correctness.test.js uses for coord-ui lib) and asserts:
//   (A) the data layer carries NO write/spawn/mutation primitive;
//   (B) the page carries NO form/POST/onClick/onChange/button mutation surface;
//   (C) the data layer DOES surface a governed-change command per setting.
// Read-only: no board/runtime side effects.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI = path.join(REPO_ROOT, "frontend", "apps", "coord-ui");
const LIB = path.join(UI, "lib", "config-view.ts");
const PAGE = path.join(UI, "app", "configuration", "page.tsx");

// Mutation/IO primitives that would indicate a write or runtime-mutation path.
// We forbid these in the config-view data layer; it must only READ.
const FORBIDDEN_LIB = [
  /\bfs\.\w*[wW]rite\w*/, // writeFile, writeFileSync, write
  /\bfs\.append\w*/,
  /\bfs\.mkdir\w*/,
  /\bfs\.rm\w*/,
  /\bfs\.unlink\w*/,
  /\bfs\.rename\w*/,
  /\bchild_process\b/,
  /\bspawn\w*\(/,
  /\bexec\w*\(/,
  /\bexecFile\w*/,
];

test("config-view data layer exists and is read-only (no write/spawn primitive)", () => {
  assert.ok(fs.existsSync(LIB), "lib/config-view.ts must exist");
  const src = fs.readFileSync(LIB, "utf8");
  for (const re of FORBIDDEN_LIB) {
    assert.ok(!re.test(src), `config-view.ts must not contain a mutation/IO primitive matching ${re}`);
  }
  // It reads the config file (existsSync + require) — that is the only fs use.
  assert.match(src, /fs\.existsSync/, "config-view must read the config file");
  assert.match(src, /requireExternal/, "config-view loads config via the shared in-workspace requirer");
  // Declares itself read-only.
  assert.match(src, /readOnly:\s*true/, "config-view must mark the view read-only");
});

test("config-view surfaces a GOVERNED change command per setting", () => {
  const src = fs.readFileSync(LIB, "utf8");
  assert.match(src, /changeCommand/, "each setting must carry a changeCommand");
  // The governed-change posture: edit the config-as-code file + commit via gov.
  assert.match(src, /gov commit/, "the change command must route through the governed commit lane");
  assert.match(src, /project\.config\.js/, "the change command must name the config-as-code file");
});

test("Configuration page is read-only (no form/POST/onClick/onChange/button)", () => {
  assert.ok(fs.existsSync(PAGE), "app/configuration/page.tsx must exist");
  const src = fs.readFileSync(PAGE, "utf8");
  const FORBIDDEN_PAGE = [
    /<form\b/i,
    /<button\b/i,
    /<input\b/i,
    /onClick=/,
    /onChange=/,
    /onSubmit=/,
    /\bfetch\(/,
    /method:\s*['"`]POST['"`]/i,
    /'use client'/, // the view is a server component; no client mutation surface
  ];
  for (const re of FORBIDDEN_PAGE) {
    assert.ok(!re.test(src), `configuration page must not contain a mutation surface matching ${re}`);
  }
  // It renders the governed change command (read-only "render-the-command").
  assert.match(src, /loadConfigView/, "page must source from the read-only data layer");
  assert.match(src, /to change/, "page must render the governed-change command per setting");
});
