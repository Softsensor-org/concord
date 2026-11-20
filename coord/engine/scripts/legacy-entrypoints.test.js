"use strict";
// COORD-960: the in-suite regression test that keeps the legacy-entrypoints risk covered after the guard retires.
// The guard (coord/engine/governance-guards.json, review.retirement_candidates) is release/verify-upgrade-bridge.sh
// step 6: every registered shim loads at its legacy coord/scripts path and returns its engine module. That check runs
// only in the release verifier, against a disposable upgraded workspace. This file runs the same identity check on the
// repo tree in the PR suite, and a negative control proves the check fails for a drifted or broken shim.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadShimRegistry, verifyShimRegistry } = require("../../paths.js");

const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
// A floor, so a registry that silently shrinks cannot pass by checking fewer shims.
const MIN_JS_SHIMS = 200;

// Same scope as step 6: JS shims only (.mjs shims are not required here), and a shim whose
// target is a node:test helper is covered by the registry check alone.
function isNodeTestHelper(file) {
  return /require\(["']node:test["']\)/.test(fs.readFileSync(file, "utf8"));
}

function identityProblems(coordDir, shims) {
  const problems = [];
  for (const shim of shims) {
    if (!/\.js$/.test(shim.path)) continue;
    if (isNodeTestHelper(path.join(coordDir, shim.target))) continue;
    try {
      const legacy = require(path.join(coordDir, shim.path));
      const engine = require(path.join(coordDir, shim.target));
      if (legacy !== engine) problems.push(`IDENTITY ${shim.path}`);
    } catch (error) {
      problems.push(`LOAD ${shim.path}: ${String(error.message).split("\n")[0]}`);
    }
  }
  return problems;
}

test("COORD-960: every registered JS shim at a legacy coord/scripts path loads and is its engine module", () => {
  const registry = loadShimRegistry(COORD_ROOT_DIR);
  const jsShims = registry.shims.filter((shim) => /\.js$/.test(shim.path));
  assert.ok(jsShims.length >= MIN_JS_SHIMS, `expected at least ${MIN_JS_SHIMS} JS shims, found ${jsShims.length}`);
  assert.deepEqual(verifyShimRegistry(COORD_ROOT_DIR, registry), [], "every registered shim delegates to its engine target");
  assert.deepEqual(identityProblems(COORD_ROOT_DIR, jsShims), [], "every registered JS shim loads and returns its engine module");
});

test("COORD-960: the identity check fails for a drifted copy and for a shim that throws on load (negative control)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord960-"));
  try {
    for (const sub of ["scripts", "engine/scripts"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    const write = (rel, text) => fs.writeFileSync(path.join(dir, rel), text);
    write("engine/scripts/good.js", "module.exports = { id: 'good' };\n");
    write("scripts/good.js", "module.exports = require('../engine/scripts/good.js');\n");
    write("engine/scripts/drift.js", "module.exports = { id: 'drift' };\n");
    write("scripts/drift.js", "module.exports = { id: 'drift' };\n"); // a copy, not a shim: identity must fail
    write("engine/scripts/broken.js", "module.exports = {};\n");
    write("scripts/broken.js", "throw new Error('boom');\n");
    const shims = [
      { path: "scripts/good.js", target: "engine/scripts/good.js" },
      { path: "scripts/drift.js", target: "engine/scripts/drift.js" },
      { path: "scripts/broken.js", target: "engine/scripts/broken.js" },
    ];
    assert.deepEqual(identityProblems(dir, shims), [
      "IDENTITY scripts/drift.js",
      "LOAD scripts/broken.js: boom",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
