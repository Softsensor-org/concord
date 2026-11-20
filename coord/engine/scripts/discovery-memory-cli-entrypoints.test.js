"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

// COORD-866 (COORD-589 batch 3): the discovery, business and memory-layer
// modules moved under coord/engine/scripts and their legacy coord/scripts paths
// became registered shims. Every CLI module now exports a zero-argument main(),
// which the CLI shim re-dispatches when it is the process entrypoint. This suite
// runs both entrypoints of every CLI module end to end and checks that the
// shim, the engine module and the coord CLI dispatcher all reach the same
// engine code.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const MODULES = [
  "business-context-pack",
  "business-context-pack-test-fixtures",
  "business-discovery",
  "business-discovery-source",
  "business-discovery-synthesize",
  "decision-extractor",
  "domain-discovery-adapters",
  "evidence-authority",
  "exploration-promotion",
  "insight-reports",
  "knowledge-claim-compiler",
  "learned-rule-promotion",
  "memory-classification",
  "memory-corpus-guard",
  "memory-eval",
  "memory-graph",
  "memory-vector",
  "onboard",
  "prework-pack",
  "recall",
  "static-config-declaration",
  "summary-tiers",
  "track-presets",
];

// Entrypoint modules and the arguments that print their usage without touching
// the memory tree. memory-eval has no usage path: any invocation runs the full
// evaluation, so memory-eval.test.js drives its process entrypoint behind a
// sandboxing preload instead.
const CLI_USAGE_ARGS = {
  "business-context-pack": ["--help"],
  "business-discovery": ["--help"],
  "business-discovery-synthesize": ["--help"],
  "decision-extractor": ["--help"],
  "exploration-promotion": ["--help"],
  "insight-reports": ["--help"],
  "knowledge-claim-compiler": ["--help"],
  "learned-rule-promotion": ["--help"],
  "memory-graph": ["--help"],
  "prework-pack": ["--help"],
  "recall": [],
  "summary-tiers": ["--help"],
};
const CLI_MODULES = [...Object.keys(CLI_USAGE_ARGS), "memory-eval"].sort();

const LEGACY_DIR = path.join(COORD_ROOT_DIR, "scripts");
const REPO_ROOT = path.dirname(COORD_ROOT_DIR);

function runNode(file, args, options = {}) {
  return spawnSync(process.execPath, [file, ...args], { cwd: REPO_ROOT, encoding: "utf8", ...options });
}

test("COORD-866: every batch-3 module is registered as a removable shim at its legacy path", () => {
  const registry = JSON.parse(fs.readFileSync(path.join(COORD_ROOT_DIR, "engine/shim-registry.json"), "utf8"));
  for (const name of MODULES) {
    const shim = registry.shims.find((entry) => entry.path === `scripts/${name}.js`);
    assert.ok(shim, `scripts/${name}.js is registered`);
    assert.equal(shim.target, `engine/scripts/${name}.js`);
    assert.equal(shim.kind, "removable");
    assert.ok(fs.existsSync(path.join(__dirname, `${name}.js`)), `engine module ${name}.js exists`);
    const legacyModule = require(path.join(LEGACY_DIR, `${name}.js`));
    assert.equal(legacyModule, require(path.join(__dirname, `${name}.js`)), `${name}: the shim is the engine module`);
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, `scripts/${name}.js`)));
    assert.equal(typeof legacyModule.main, CLI_MODULES.includes(name) ? "function" : "undefined", name);
  }
});

for (const [name, args] of Object.entries(CLI_USAGE_ARGS)) {
  test(`COORD-866: ${name} usage runs through the legacy CLI shim and the engine entrypoint`, () => {
    const engine = runNode(path.join(__dirname, `${name}.js`), args);
    const legacy = runNode(path.join(LEGACY_DIR, `${name}.js`), args);
    assert.ifError(engine.error);
    assert.ifError(legacy.error);
    assert.equal(engine.status, 0, engine.stderr);
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.match(engine.stdout, /Usage:/);
    assert.doesNotMatch(engine.stdout, /coord\/scripts\/[\w-]+\.js/, "usage names the engine path, not the shim");
    assert.equal(legacy.stdout, engine.stdout, "the shim re-dispatches the engine main");
    // COORD-991: the removable legacy shim adds exactly its deprecation line to the engine's stderr.
    assert.equal(legacy.stderr, `DEPRECATED: coord/scripts/${name}.js is a legacy shim and will be removed in 0.3.0. Use coord/engine/scripts/${name}.js instead.\n${engine.stderr}`);
  });
}

test("COORD-866: a failing CLI keeps its non-zero exit code through the shim", () => {
  for (const name of ["business-discovery", "knowledge-claim-compiler", "exploration-promotion"]) {
    const engine = runNode(path.join(__dirname, `${name}.js`), ["--definitely-unknown-option"]);
    const legacy = runNode(path.join(LEGACY_DIR, `${name}.js`), ["--definitely-unknown-option"]);
    assert.notEqual(engine.status, 0, `${name}: ${engine.stdout}`);
    assert.equal(legacy.status, engine.status, name);
    assert.equal(legacy.stdout, engine.stdout, name);
  }
});

test("COORD-866: the coord CLI dispatches discovery commands to the engine modules", () => {
  const cli = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/coord-cli.js"));
  const lines = [];
  const result = cli.dispatch(["business-discovery", "--help"], { log: (line) => lines.push(String(line)) });
  assert.equal(result.code, 0);
  assert.match(lines.join("\n"), /^Usage: business-discovery /);
  const spawned = runNode(path.join(LEGACY_DIR, "coord-cli.js"), ["business-context-pack", "--help"]);
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.equal(spawned.stdout, runNode(path.join(__dirname, "business-context-pack.js"), ["--help"]).stdout);
});
