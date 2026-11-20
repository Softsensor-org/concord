"use strict";
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { resolveEngineModule, verifyShimRegistry, loadShimRegistry, renderShimSource } = require("../../paths.js");

// COORD-869 (COORD-589 batch 6): the landing, closeout, control-plane, git,
// worktree and PR modules moved under coord/engine/scripts; their legacy
// coord/scripts paths are registered removable shims. closeout-summary is the
// batch's only process entrypoint, so its shim is the CLI template that
// re-dispatches the engine main(); every other shim is the plain re-export.
// The governance composition root must keep resolving the ONE engine copy of
// each module: a second copy would mean two git/worktree/landing states.

const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const LEGACY_DIR = path.join(COORD_ROOT_DIR, "scripts");

const CLI_MODULES = ["closeout-summary"];
const MODULES = [
  "closeout",
  "closeout-summary",
  "control-plane-fulfillment",
  "control-plane-landing",
  "control-plane-merge-history",
  "control-plane-paths",
  "control-plane-push",
  "control-plane-push-history",
  "git-ops",
  "governed-external-effect",
  "governed-workspace-recovery",
  "landing-audit",
  "landing-audit-vocabulary",
  "landing-corrections",
  "landing-decision-packet",
  "landing-gh",
  "landing-reconciliation",
  "landing-resolution",
  "lifecycle-repox-closeout",
  "pr-ops",
  "reconcile-packet",
  "workspace-container-witness",
  "worktree-ops",
];

test("COORD-869: every batch-6 module is registered as a removable shim at its legacy path", () => {
  const registry = loadShimRegistry(COORD_ROOT_DIR);
  for (const name of MODULES) {
    const rel = `scripts/${name}.js`;
    const shim = registry.shims.find((entry) => entry.path === rel);
    assert.ok(shim, `${rel} is registered`);
    assert.equal(shim.target, `engine/${rel}`);
    assert.equal(shim.kind, "removable");
    assert.ok(fs.existsSync(path.join(__dirname, `${name}.js`)), `engine module ${name}.js exists`);
    const cli = CLI_MODULES.includes(name);
    const shimText = fs.readFileSync(path.join(LEGACY_DIR, `${name}.js`), "utf8");
    const templateBody = renderShimSource(rel, { cli }).split("\n").filter((line) => line && !line.startsWith('"use strict"'));
    for (const line of templateBody) assert.ok(shimText.includes(line), `${rel} is the ${cli ? "CLI" : "module"} shim template`);
    const legacyModule = require(path.join(LEGACY_DIR, `${name}.js`));
    assert.equal(legacyModule, require(path.join(__dirname, `${name}.js`)), `${name}: the shim is the engine module`);
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, rel)));
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, `engine-only:${rel}`)));
    assert.equal(typeof legacyModule.main, cli ? "function" : "undefined", `${name} ${cli ? "is" : "is not"} a CLI`);
  }
  assert.deepEqual(verifyShimRegistry(COORD_ROOT_DIR), [], "every registered shim delegates to its engine target");
});

test("COORD-869: the governance composition root loads the one engine copy of each batch-6 module", () => {
  const lifecycle = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle.js"));
  assert.equal(typeof lifecycle.commands, "object");
  for (const name of ["closeout", "git-ops", "worktree-ops", "pr-ops", "control-plane-paths", "landing-corrections"]) {
    const engineFile = path.join(__dirname, `${name}.js`);
    assert.ok(require.cache[engineFile], `${name}: the engine copy is the loaded module`);
    const legacyFile = path.join(LEGACY_DIR, `${name}.js`);
    if (require.cache[legacyFile]) {
      assert.equal(require.cache[legacyFile].exports, require.cache[engineFile].exports, `${name}: the legacy path only re-exports the engine copy`);
    }
  }
});

test("COORD-869: closeout-summary prints the same usage through its engine path and its legacy CLI shim", () => {
  const outputs = [path.join(__dirname, "closeout-summary.js"), path.join(LEGACY_DIR, "closeout-summary.js")].map((script) => {
    const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Usage:/);
    assert.match(run.stdout, /node coord\/engine\/scripts\/closeout-summary\.js <ticket-id> \[--json\]/);
    return run.stdout;
  });
  assert.equal(outputs[0], outputs[1]);
});
