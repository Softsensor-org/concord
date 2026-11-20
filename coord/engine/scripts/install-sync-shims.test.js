"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule, verifyShimRegistry, loadShimRegistry, isStableEntrypoint } = require("../../paths.js");

// COORD-870 (COORD-589 batch 7): the install, sync and upgrade modules (coord
// init and its wizard, coord upgrade and its lock/release source, the engine
// pin, the conformance verbs and attestation, sync provenance, template-sync
// discovery) plus the COORD-875 batch-7 assignments moved under
// coord/engine/scripts. template-sync-discovery.js and check-template-sync.sh
// are stable adopter entrypoints, so their legacy paths are PERMANENT shims;
// every other legacy path is a removable shim. agent-shim-validator.js and
// canonical-derived-authority.js are CLIs, so their shims re-dispatch main.

const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.dirname(COORD_ROOT_DIR);
const LEGACY_DIR = path.join(COORD_ROOT_DIR, "scripts");

const LIBRARY_MODULES = [
  "adoption-profile-registry",
  "conformance-attestation",
  "conformance-verbs",
  "coord-conformance",
  "coord-init",
  "coord-init-starter-board",
  "coord-init-wizard",
  "coord-upgrade",
  "engine-pin",
  "governance-phase-model",
  "readiness-doctor",
  "sync-provenance",
  "tree-mutation-safety",
  "upgrade-lock",
  "upgrade-release-source",
];
const CLI_MODULES = ["agent-shim-validator", "canonical-derived-authority", "template-sync-discovery"];
const PERMANENT = new Set(["scripts/template-sync-discovery.js", "scripts/check-template-sync.sh"]);

test("COORD-870: every batch-7 module is a registered shim of the right kind at its legacy path", () => {
  const registry = loadShimRegistry(COORD_ROOT_DIR);
  for (const name of [...LIBRARY_MODULES, ...CLI_MODULES]) {
    const rel = `scripts/${name}.js`;
    const shim = registry.shims.find((entry) => entry.path === rel);
    assert.ok(shim, `${rel} is registered`);
    assert.equal(shim.target, `engine/${rel}`);
    assert.equal(shim.kind, PERMANENT.has(rel) ? "permanent" : "removable", rel);
    assert.equal(isStableEntrypoint(registry, rel), PERMANENT.has(rel), `${rel} stable-entrypoint status`);
    assert.ok(fs.existsSync(path.join(__dirname, `${name}.js`)), `engine module ${name}.js exists`);
    const legacyModule = require(path.join(LEGACY_DIR, `${name}.js`));
    assert.equal(legacyModule, require(path.join(__dirname, `${name}.js`)), `${name}: the shim is the engine module`);
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, rel)));
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, `engine-only:${rel}`)));
    if (CLI_MODULES.includes(name)) assert.equal(typeof legacyModule.main, "function", `${name} exports main for its CLI shim`);
    else assert.equal(typeof legacyModule.main, "undefined", `${name} is a library module, not a CLI`);
  }
  const shell = registry.shims.find((entry) => entry.path === "scripts/check-template-sync.sh");
  assert.deepEqual(shell, { path: "scripts/check-template-sync.sh", target: "engine/scripts/check-template-sync.sh", kind: "permanent" });
  assert.deepEqual(verifyShimRegistry(COORD_ROOT_DIR), [], "every registered shim delegates to its engine target");
});

test("COORD-870: the legacy CLI entrypoints dispatch the engine command line with its exit codes", () => {
  const run = (args) => spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8" });
  const entrypoints = (name) => [path.join(LEGACY_DIR, `${name}.js`), path.join(__dirname, `${name}.js`)];
  for (const file of entrypoints("template-sync-discovery")) {
    const help = run([file, "--help"]);
    assert.equal(help.status, 0, `${file} --help: ${help.stderr}`);
    assert.match(help.stdout, /--write\s+Regenerate coord\/TEMPLATE_SYNC_MANIFEST\.json/);
  }
  for (const file of entrypoints("canonical-derived-authority")) {
    const result = run([file, "--canonical-input", "coord/rendered/TASKS.md"]);
    assert.notEqual(result.status, 0, `${file} rejects a derived view named as canonical input`);
  }
  for (const file of entrypoints("agent-shim-validator")) {
    const result = run([file, "--definitely-not-a-flag"]);
    assert.equal(typeof result.status, "number", `${file} exits with a status`);
    assert.notEqual(result.status, 0, `${file} rejects an unknown flag`);
  }
});

test("COORD-870: the permanent check-template-sync.sh launcher runs the engine check with the caller's arguments", () => {
  const legacy = path.join(LEGACY_DIR, "check-template-sync.sh");
  assert.ok(fs.statSync(legacy).mode & 0o111, "the legacy launcher stays executable");
  const viaShim = spawnSync("bash", [legacy, "--help"], { cwd: REPO_ROOT, encoding: "utf8" });
  const direct = spawnSync("bash", [path.join(__dirname, "check-template-sync.sh"), "--help"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(viaShim.status, 0, viaShim.stderr);
  assert.equal(viaShim.stdout, direct.stdout);
  const missing = spawnSync("bash", [legacy, "--repo-root"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(missing.status, 2, "a usage error keeps the engine script's exit code");
  assert.match(missing.stderr, /Missing value for --repo-root/);
});
