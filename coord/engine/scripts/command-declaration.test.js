"use strict";

// COORD-934: the one command declaration. The router (cli.js ROUTES, built from this declaration) must
// route exactly the spellings it declares; the derived class, promotion and dry-run views are the ones
// the pre-change literal lists produced.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const declaration = require("./command-declaration.js");
const { collectDispatchCommandVerbs } = require("./verb-parity.js");
const authority = require("./integration-authority.js");

const CLASS_ORDER = ["integration", "identity", "read", "write", "authority"];
const CLI_SOURCE = fs.readFileSync(path.join(__dirname, "cli.js"), "utf8");

// COORD-1016 / COORD-1021: the route table is the declaration. cli.js builds ROUTES from ROWS and
// ROUTE_HANDLERS; no literal dispatch switch remains to scan.
const { ROUTES, ROUTE_HANDLERS } = require("./cli.js").__testing;

test("COORD-1016: the declaration-backed collector returns the same verb set as the router", () => {
  assert.deepEqual([...collectDispatchCommandVerbs(CLI_SOURCE)].sort(), [...declaration.SPELLINGS].sort(), "collector == declaration");
  assert.deepEqual([...ROUTES.keys()].sort(), [...declaration.SPELLINGS].sort(), "router == declaration");
});

test("COORD-934 / COORD-1021: the router routes exactly the declared spellings, both directions", () => {
  const routed = [...ROUTES.keys()].sort();
  const declared = [...declaration.SPELLINGS].sort();
  assert.deepEqual(declared.filter((verb) => !routed.includes(verb)), [], "a declared spelling the router does not route");
  assert.deepEqual(routed.filter((verb) => !declared.includes(verb)), [], "a routed spelling with no declaration row");
  assert.equal(new Set(declaration.SPELLINGS).size, declaration.SPELLINGS.length, "one row per spelling");

  const { spawnSync } = require("node:child_process");
  const forwarding = spawnSync(process.execPath, ["-e", [
    'const Module = require("node:module");',
    'const assert = require("node:assert/strict");',
    'const lifecycle = require("./lifecycle.js");',
    'const original = Module._load;',
    'const event = { event: "fixture.diagnostic" };',
    'const observed = [];',
    'Module._load = function (request, parent, isMain) {',
    '  if (request === "./integration-commands.js" && parent.filename === require.resolve("./cli.js")) {',
    '    return { createIntegrationCommands({ appendGovernanceEvent }) {',
    '      return { integrationCommand(args) {',
    '        assert.deepEqual(args, ["status"]);',
    '        lifecycle.__testing.appendGovernanceEvent = (value) => { observed.push(value); return value; };',
    '        return appendGovernanceEvent(event);',
    '      } };',
    '    } };',
    '  }',
    '  return original.call(this, request, parent, isMain);',
    '};',
    'const { dispatchCommand } = require("./cli.js").__testing;',
    'assert.equal(dispatchCommand("integration", ["status"]), event);',
    'assert.deepEqual(observed, [event]);',
  ].join("\n")], { cwd: __dirname, encoding: "utf8" });
  assert.equal(forwarding.status, 0, forwarding.stderr);
});

test("COORD-1021: the handler table has exactly one entry per declared handler id", () => {
  const handlers = [...new Set(declaration.ROWS.map((row) => row.handler))].sort();
  assert.deepEqual(Object.keys(ROUTE_HANDLERS).sort(), handlers, "table keys == declared handler ids");
  for (const handler of handlers) assert.equal(typeof ROUTE_HANDLERS[handler], "function", handler);

  const { spawnSync } = require("node:child_process");
  const broken = spawnSync(process.execPath, ["-e", [
    'const Module = require("node:module");',
    'const assert = require("node:assert/strict");',
    'const original = Module._load;',
    'Module._load = function (request, parent, isMain) {',
    '  if (request === "./command-declaration.js" && parent.filename === require.resolve("./cli.js")) {',
    '    return { ROWS: [{ spelling: "fixture", handler: "missing-fixture-handler" }] };',
    '  }',
    '  return original.call(this, request, parent, isMain);',
    '};',
    'assert.throws(() => require("./cli.js"), /cli.js has no route for handler missing-fixture-handler/);',
  ].join("\n")], { cwd: __dirname, encoding: "utf8" });
  assert.equal(broken.status, 0, broken.stderr);
});

test("COORD-1021: aliases resolve to the same route object as their canonical spelling", () => {
  for (const row of declaration.ROWS.filter((r) => r.aliasOf)) {
    assert.equal(ROUTES.get(row.spelling), ROUTES.get(row.aliasOf), `${row.spelling} routes like ${row.aliasOf}`);
  }
  const distinct = new Set(declaration.ROWS.map((row) => ROUTES.get(row.spelling)));
  assert.equal(distinct.size, new Set(declaration.ROWS.map((row) => row.handler)).size, "one route object per handler id");
});

test("COORD-1021: prototype-named spellings are unknown to the router, not routes", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(ROUTES.get(name), undefined, name);
  }
});

test("COORD-1021: every row names a function, one function per handler id and no two handler ids share one", () => {
  const byHandler = new Map();
  for (const row of declaration.ROWS) {
    assert.ok(typeof row.fn === "string" && row.fn.length > 0, `${row.spelling} names its handler function`);
    if (byHandler.has(row.handler)) assert.equal(byHandler.get(row.handler), row.fn, `${row.handler} has one function`);
    byHandler.set(row.handler, row.fn);
  }
  assert.equal(new Set(byHandler.values()).size, byHandler.size, "distinct handler ids name distinct functions");
});

test("COORD-934: every row carries a known class and an alias names a canonical spelling that handles it", () => {
  const byName = new Map(declaration.ROWS.map((row) => [row.spelling, row]));
  for (const row of declaration.ROWS) {
    assert.ok(CLASS_ORDER.includes(row.class), `${row.spelling} has class ${row.class}`);
    if (row.aliasOf) {
      const canonical = byName.get(row.aliasOf);
      assert.ok(canonical, `${row.spelling} aliases ${row.aliasOf}, which is not declared`);
      assert.equal(row.handler, canonical.handler, `${row.spelling} shares the handler of ${row.aliasOf}`);
      assert.equal(canonical.aliasOf ?? null, null, `${row.aliasOf} is canonical, not itself an alias`);
    } else {
      assert.equal(row.handler, row.spelling, `${row.spelling} is canonical and handles itself`);
    }
  }
});

test("COORD-934: derived classes cover every spelling exactly once", () => {
  const classified = CLASS_ORDER.flatMap((cls) => declaration.VERB_CLASSES[cls]);
  assert.deepEqual([...classified].sort(), [...declaration.SPELLINGS].sort(), "classes partition the spellings");
  assert.deepEqual(
    Object.fromEntries(CLASS_ORDER.map((cls) => [cls, declaration.VERB_CLASSES[cls].length])),
    { integration: 18, identity: 7, read: 48, write: 84, authority: 1 },
    "per-class counts match the pre-change literal lists",
  );
});

test("COORD-934: flag promotions and dry-run rows are the pre-change lists, and dry-run spellings are routed", () => {
  assert.deepEqual(declaration.FLAG_PROMOTIONS, {
    doctor: { "--fix": "write" },
    orch: { "--fix": "write" },
    "orchestrator-cycle": { "--fix": "write" },
    "audit-landings": { "--write": "integration" },
    "verify-engine": { "--pin": "write" },
    "merge-queue": { "--record": "write" },
    reconcile: { "--dry-run": "read" },
  });
  assert.deepEqual(Object.keys(declaration.DRY_RUN_VERBS).sort(), [
    "claim", "coverage-rollup", "promote", "quality-scan", "reap-gate-procs", "reconcile",
    "record-managed-evidence", "repair-lock-head", "resolve-question", "retire-stale-drift-notes",
  ]);
  for (const verb of Object.keys(declaration.DRY_RUN_VERBS)) {
    assert.ok(declaration.SPELLINGS.includes(verb), `${verb} has a dry-run preview and is declared`);
  }
});

test("COORD-934: integration-authority classifies through the declaration, not a private list", () => {
  assert.equal(authority.VERB_CLASSES, declaration.VERB_CLASSES);
  assert.equal(authority.FLAG_PROMOTIONS, declaration.FLAG_PROMOTIONS);
  assert.equal(authority.classifyCommand("reconcile", ["--dry-run"]), "read");
  assert.equal(authority.classifyCommand("reconcile", []), "integration");
  assert.equal(authority.classifyCommand("doctor", ["--fix"]), "write");
  assert.equal(authority.classifyCommand("future-read-verb", []), "read", "unknown spellings default to read");
});
