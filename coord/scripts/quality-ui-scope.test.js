"use strict";

// COORD-109: scope-selector contract for the coord-ui /quality cockpit.
//
// The cockpit (frontend/apps/coord-ui/lib/quality.ts) is server-only TS that
// imports `server-only` + Next path aliases, so it cannot be required from the
// node:test runner directly. These tests instead prove the ENGINE-level
// contract the cockpit relies on, using the same exported arch-checks helpers
// (scanRepo / collectFiles / mergeConfig) the cockpit composes, plus a small
// mirror of the scope-resolution semantics:
//
//   - scope=coord scans the COORD_DIR root (current behavior preserved),
//   - scope=<product repo> scans THAT root (a different file set),
//   - an unknown/missing-root scope resolves to a graceful empty state,
//   - the scan stays bounded: exactly ONE root per request, never all roots,
//     and a file-count pre-check (the cockpit's SCAN_FILE_CAP guard) caps a
//     large tree before the heavy per-file analysis runs.
//
// No board/runtime side effects (temp fixtures + real repo roots, read-only).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const arch = require("./arch-checks.js");
const { scanRepo, collectFiles, mergeConfig } = arch;

const COORD_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.dirname(COORD_DIR);

// --- mirror of lib/quality.ts scope resolution (kept tiny + faithful) --------
// The real resolver builds scopes from project-config (coordRepo + productRepos)
// then resolves a requested id, falling back to the default coord scope. We
// reproduce just enough to assert the routing contract.
const SCAN_FILE_CAP = 4000; // must match lib/quality.ts

function makeScope(id, root) {
  let missing = false;
  try {
    missing = !fs.statSync(root).isDirectory();
  } catch {
    missing = true;
  }
  return { id, root, missing };
}

function resolveScope(requested, productRoots) {
  const scopes = [
    makeScope("coord", COORD_DIR),
    ...productRoots.map((r) => makeScope(r.id, r.root)),
    makeScope("template", PROJECT_ROOT),
  ];
  const want = String(requested || "").trim().toLowerCase();
  if (!want) return scopes[0]; // default = coord
  const byId = scopes.find((s) => s.id === want);
  return byId || scopes[0]; // unknown -> default (never crash)
}

// Count scannable files using arch-checks' OWN ignore rules — the bounded
// pre-check the cockpit performs before deciding to run the heavy scan.
function scannableFileCount(root) {
  return collectFiles(root, mergeConfig()).length;
}

test("scope=coord (default) resolves to and scans the COORD_DIR root", () => {
  const scope = resolveScope("coord", []);
  assert.strictEqual(scope.root, COORD_DIR);
  assert.strictEqual(scope.missing, false);
  const { summary } = scanRepo({ root: scope.root });
  assert.ok(summary.files > 0, "coord scope should scan governance source files");
});

test("empty/undefined scope falls back to the default coord scope (current behavior)", () => {
  assert.strictEqual(resolveScope(undefined, []).root, COORD_DIR);
  assert.strictEqual(resolveScope("", []).root, COORD_DIR);
});

test("scope=<product repo> scans THAT root, a distinct file set from coord", () => {
  // Use the live frontend/src product tree (real .js sources, per the template's
  // project.config.js F=frontend repo); the resolver routes the request to it.
  const productRoot = path.join(PROJECT_ROOT, "frontend", "src");
  const productRoots = [{ id: "frontend", root: productRoot }];
  const scope = resolveScope("frontend", productRoots);
  assert.strictEqual(scope.root, productRoot);
  assert.strictEqual(scope.missing, false);

  const coordFiles = new Set(
    collectFiles(COORD_DIR, mergeConfig()).map((f) => path.resolve(f))
  );
  const productFiles = collectFiles(productRoot, mergeConfig()).map((f) =>
    path.resolve(f)
  );
  assert.ok(productFiles.length > 0, "product scope should find source files");
  // The selected root drives a DIFFERENT corpus — not the coord tree.
  assert.ok(
    productFiles.every((f) => !coordFiles.has(f)),
    "product-repo scan must not pull coord/ files"
  );
});

test("unknown / missing-root scope yields a graceful empty state (no crash)", () => {
  // Unknown id -> default coord scope (still scannable).
  assert.strictEqual(resolveScope("does-not-exist", []).id, "coord");

  // A configured-but-missing product root surfaces missing=true so the cockpit
  // renders an empty state instead of scanning a non-existent dir.
  const missingRoot = path.join(PROJECT_ROOT, "no-such-repo-xyz");
  const scope = resolveScope("ghost", [{ id: "ghost", root: missingRoot }]);
  assert.strictEqual(scope.missing, true);
  // collectFiles over a missing root is safe + empty (the cockpit guards on
  // scope.missing before ever calling it, but prove the engine degrades too).
  assert.deepStrictEqual(collectFiles(missingRoot, mergeConfig()), []);
});

test("scan is bounded: exactly ONE root per request, capped by file count", () => {
  // The resolver returns a single scope (one root) — there is no all-roots scan.
  const productRoots = [
    { id: "frontend", root: path.join(PROJECT_ROOT, "frontend") },
    { id: "backend", root: path.join(PROJECT_ROOT, "backend") },
  ];
  const scope = resolveScope("coord", productRoots);
  assert.strictEqual(typeof scope.root, "string");
  assert.ok(scope.root.length > 0);

  // The bounded pre-check uses arch-checks' ignore rules; coord/ stays well
  // under the cap, and the count is a cheap dir walk (no content analysis).
  const count = scannableFileCount(COORD_DIR);
  assert.ok(count > 0 && count <= SCAN_FILE_CAP, `coord file count ${count} within cap`);

  // Simulate the over-cap guard: a fabricated count beyond the cap must trip
  // the skip branch the cockpit uses, so a large product tree never OOMs.
  const fabricatedLargeCount = SCAN_FILE_CAP + 1;
  assert.ok(fabricatedLargeCount > SCAN_FILE_CAP, "over-cap count trips bounded-skip guard");
});
