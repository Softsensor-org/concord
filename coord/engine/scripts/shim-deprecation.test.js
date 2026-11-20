"use strict";
// COORD-991 (ARCH-AUDIT-2026-11-13 F-09; human-admin decision 2026-11-13): removable legacy shims are
// deprecated in 0.2.0 with one stderr line naming the engine path and the 0.3.0 removal. Permanent
// stable entrypoints never warn: hook shims run on every tool call, and fail-closed templates keep
// their exit codes and stdout exactly as before.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { renderShimSource, shimDelegates, loadShimRegistry } = require("../../paths.js");

const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const registry = loadShimRegistry(COORD_ROOT_DIR);
const removable = registry.shims.filter((shim) => shim.kind === "removable");
const permanent = registry.shims.filter((shim) => shim.kind === "permanent");
const DEPRECATION = "DEPRECATED: coord/";
const warningFor = (rel) => `DEPRECATED: coord/${rel} is a legacy shim and will be removed in 0.3.0. Use coord/engine/${rel} instead.`;
const countOf = (text, needle) => text.split(needle).length - 1;

test("COORD-991: a deprecated module shim adds exactly one stderr line and nothing else", () => {
  const rel = "scripts/closeout.js";
  const plain = renderShimSource(rel);
  const deprecated = renderShimSource(rel, { deprecated: true });
  assert.equal(countOf(plain, DEPRECATION), 0);
  assert.equal(countOf(deprecated, DEPRECATION), 1);
  assert.ok(deprecated.includes(`process.stderr.write(${JSON.stringify(`${warningFor(rel)}\n`)});`));
  assert.equal(deprecated.replace(/^process\.stderr\.write\(.*\);\n/m, ""), plain);
});

test("COORD-991: CLI and ESM deprecated templates warn too; fail-closed templates never do", () => {
  assert.equal(countOf(renderShimSource("scripts/closeout-summary.js", { cli: true, deprecated: true }), DEPRECATION), 1);
  assert.equal(countOf(renderShimSource("scripts/evidence-export.mjs", { deprecated: true }), DEPRECATION), 1);
  for (const rel of ["scripts/hooks/post-bash.js", "scripts/runtime-authority-hook.js"]) {
    for (const cli of [false, true]) {
      const failClosed = renderShimSource(rel, { cli, failClosed: true, deprecated: true });
      assert.equal(failClosed, renderShimSource(rel, { cli, failClosed: true }), `${rel} cli=${cli}`);
      assert.equal(countOf(failClosed, DEPRECATION), 0, `${rel} cli=${cli}`);
    }
  }
});

test("COORD-991: shimDelegates checks a removable shim against the deprecated template and a permanent one against the plain template", () => {
  const rel = "scripts/closeout.js";
  const plain = renderShimSource(rel);
  const deprecated = renderShimSource(rel, { deprecated: true });
  assert.equal(shimDelegates(deprecated, rel, "removable"), true);
  assert.equal(shimDelegates(plain, rel, "removable"), false);
  assert.equal(shimDelegates(plain, rel, "permanent"), true);
  assert.equal(shimDelegates(deprecated, rel, "permanent"), false);
});

test("COORD-991: every removable shim on disk is byte-identical to the deprecated renderer output", () => {
  assert.ok(removable.length > 0, "the registry declares removable shims");
  for (const shim of removable) {
    const text = fs.readFileSync(path.join(COORD_ROOT_DIR, shim.path), "utf8");
    const identical = [false, true].some((cli) => text === renderShimSource(shim.path, { cli, deprecated: true }));
    assert.ok(identical, `${shim.path} is the deprecated shim template, byte for byte`);
  }
});

test("COORD-991: permanent stable entrypoints never carry the deprecation and still delegate", () => {
  assert.ok(permanent.length > 0, "the registry declares permanent shims");
  for (const shim of permanent) {
    const text = fs.readFileSync(path.join(COORD_ROOT_DIR, shim.path), "utf8");
    assert.equal(countOf(text, DEPRECATION), 0, shim.path);
    assert.equal(shimDelegates(text, shim.path, shim.kind), true, shim.path);
  }
});

test("COORD-991: loading a removable shim twice warns once on stderr and leaves stdout and the exit code alone", () => {
  const rel = "scripts/closeout.js";
  const shim = JSON.stringify(path.join(COORD_ROOT_DIR, rel));
  const result = spawnSync(process.execPath, ["-e", `require(${shim}); require(${shim});`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(countOf(result.stderr, DEPRECATION), 1, result.stderr);
  assert.ok(result.stderr.includes(warningFor(rel)), result.stderr);
});

test("COORD-991: a permanent hook shim loads silently, so no tool-call hook prints a warning", () => {
  const hook = JSON.stringify(path.join(COORD_ROOT_DIR, "scripts", "hooks", "hook-lib.js"));
  const result = spawnSync(process.execPath, ["-e", `require(${hook});`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(countOf(result.stderr, DEPRECATION), 0, result.stderr);
});
