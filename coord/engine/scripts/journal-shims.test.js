"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { resolveEngineModule, verifyShimRegistry, loadShimRegistry } = require("../../paths.js");

// COORD-868 (COORD-589 batch 5): the journal modules (hash chain, snapshots,
// seal, retention, repair, loss guard, signing and signer trust), the chain
// migration signers, the external side-effect recorder and the OTLP exporter
// moved under coord/engine/scripts; their legacy coord/scripts paths are
// registered removable shims. None of them is a CLI, so each shim is the plain
// re-export template. The governance hot path (lifecycle.js, the hooks and the
// control-plane landing) must keep resolving the ONE engine copy: a second
// copy would mean two journal writers with two caches.

const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const LEGACY_DIR = path.join(COORD_ROOT_DIR, "scripts");

const MODULES = [
  "chain-migration-signing",
  "chain-transition-signer",
  "governance-side-effects",
  "journal",
  "journal-chain",
  "journal-loss-guard",
  "journal-repair",
  "journal-retention",
  "journal-seal",
  "journal-signature-trust",
  "journal-signing",
  "journal-snapshots",
  "otlp-export",
];

test("COORD-868: every batch-5 module is registered as a removable shim at its legacy path", () => {
  const registry = loadShimRegistry(COORD_ROOT_DIR);
  for (const name of MODULES) {
    const shim = registry.shims.find((entry) => entry.path === `scripts/${name}.js`);
    assert.ok(shim, `scripts/${name}.js is registered`);
    assert.equal(shim.target, `engine/scripts/${name}.js`);
    assert.equal(shim.kind, "removable");
    assert.ok(fs.existsSync(path.join(__dirname, `${name}.js`)), `engine module ${name}.js exists`);
    const legacyModule = require(path.join(LEGACY_DIR, `${name}.js`));
    assert.equal(legacyModule, require(path.join(__dirname, `${name}.js`)), `${name}: the shim is the engine module`);
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, `scripts/${name}.js`)));
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, `engine-only:scripts/${name}.js`)));
    assert.equal(typeof legacyModule.main, "undefined", `${name} is a library module, not a CLI`);
  }
  assert.deepEqual(verifyShimRegistry(COORD_ROOT_DIR), [], "every registered shim delegates to its engine target");
});

test("COORD-868: the governance composition root and its journal consumers load the one engine journal copy", () => {
  const lifecycle = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle.js"));
  assert.equal(typeof lifecycle.commands, "object");
  for (const consumer of ["control-plane-landing", "coord-init", "reconcile-packet", "lifecycle-help"]) {
    require(resolveEngineModule(COORD_ROOT_DIR, `scripts/${consumer}.js`));
  }
  for (const name of MODULES) {
    const engineFile = path.join(__dirname, `${name}.js`);
    const legacyFile = path.join(LEGACY_DIR, `${name}.js`);
    assert.ok(require.cache[engineFile], `${name}: the engine copy is the loaded module`);
    if (require.cache[legacyFile]) {
      assert.equal(require.cache[legacyFile].exports, require.cache[engineFile].exports, `${name}: the legacy path only re-exports the engine copy`);
    }
  }
  const journal = require("./journal.js");
  assert.equal(typeof journal, "function", "createJournal is the DI factory");
  assert.equal(require(path.join(LEGACY_DIR, "journal.js")), journal);
});
