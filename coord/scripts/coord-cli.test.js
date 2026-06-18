"use strict";

// COORD-116: tests for the product-facing `coord` CLI dispatcher + `coord init`.
// Never mutates the real repo's coord/ — every init test uses an os.tmpdir()
// scratch directory.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { dispatch, buildRegistry } = require("./coord-cli.js");
const createCoordInit = require("./coord-init.js");
const { buildStarterBoard } = require("./coord-init-starter-board.js");

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), lines, text: () => lines.join("\n") };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coord-init-test-"));
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

test("dispatch with no args prints usage and exits 0", () => {
  const cap = capture();
  const result = dispatch([], { log: cap.log });
  assert.strictEqual(result.code, 0);
  assert.match(cap.text(), /Usage: coord <command>/);
  assert.match(cap.text(), /init/);
});

test("dispatch help/--help/-h all print usage and exit 0", () => {
  for (const arg of ["help", "--help", "-h"]) {
    const cap = capture();
    const result = dispatch([arg], { log: cap.log });
    assert.strictEqual(result.code, 0, `arg=${arg}`);
    assert.match(cap.text(), /Commands:/);
  }
});

test("dispatch routes a known command to its run()", () => {
  let routedArgs = null;
  const registry = {
    init: { summary: "x", run: (args) => { routedArgs = args; return { code: 0 }; } },
  };
  const cap = capture();
  const result = dispatch(["init", "--dry-run", "--dir", "/x"], { log: cap.log, registry });
  assert.strictEqual(result.code, 0);
  assert.deepStrictEqual(routedArgs, ["--dry-run", "--dir", "/x"]);
});

test("dispatch on unknown command errors with exit 1", () => {
  const cap = capture();
  const result = dispatch(["frobnicate"], { log: cap.log });
  assert.strictEqual(result.code, 1);
  assert.match(cap.text(), /unknown command 'frobnicate'/);
});

test("buildRegistry registers init", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.ok(registry.init);
  assert.strictEqual(typeof registry.init.run, "function");
});

// ---------------------------------------------------------------------------
// coord init
// ---------------------------------------------------------------------------

test("init in a fresh dir creates config, board, and product stubs", () => {
  const root = tmpRoot();
  const cap = capture();
  const init = createCoordInit({ log: cap.log, cwd: () => root });
  const result = init.run(["--dir", root]);

  assert.strictEqual(result.code, 0);
  for (const rel of [
    "coord/project.config.js",
    "coord/board/tasks.json",
    "coord/product/REQUIREMENTS.md",
    "coord/product/ARCHITECTURE.md",
    "coord/product/MVP_AND_PHASE_MATRIX.md",
  ]) {
    assert.ok(fs.existsSync(path.join(root, rel)), `expected ${rel} to exist`);
  }

  // The seeded board is the canonical starter-board shape.
  const board = JSON.parse(fs.readFileSync(path.join(root, "coord/board/tasks.json"), "utf8"));
  assert.deepStrictEqual(board, buildStarterBoard());
  assert.match(cap.text(), /create {2}coord\/project\.config\.js/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("init is idempotent — re-running clobbers nothing and exits 0", () => {
  const root = tmpRoot();
  createCoordInit({ log: () => {}, cwd: () => root }).run(["--dir", root]);

  // Mutate the config to prove it is preserved on re-run.
  const cfgPath = path.join(root, "coord/project.config.js");
  fs.writeFileSync(cfgPath, "module.exports = { CUSTOM: true };\n");
  const boardPath = path.join(root, "coord/board/tasks.json");
  fs.writeFileSync(boardPath, '{"version":99,"sentinel":true}\n');

  const cap = capture();
  const result = createCoordInit({ log: cap.log, cwd: () => root }).run(["--dir", root]);
  assert.strictEqual(result.code, 0);
  assert.match(cap.text(), /Already initialized/);
  assert.match(cap.text(), /skip {4}coord\/project\.config\.js/);

  // Files preserved byte-for-byte.
  assert.strictEqual(fs.readFileSync(cfgPath, "utf8"), "module.exports = { CUSTOM: true };\n");
  assert.strictEqual(fs.readFileSync(boardPath, "utf8"), '{"version":99,"sentinel":true}\n');

  fs.rmSync(root, { recursive: true, force: true });
});

test("init --dry-run writes nothing", () => {
  const root = tmpRoot();
  const cap = capture();
  const init = createCoordInit({ log: cap.log, cwd: () => root });
  const result = init.run(["--dir", root, "--dry-run"]);

  assert.strictEqual(result.code, 0);
  assert.match(cap.text(), /dry run/);
  assert.match(cap.text(), /Would create/);
  assert.ok(!fs.existsSync(path.join(root, "coord/project.config.js")));
  assert.ok(!fs.existsSync(path.join(root, "coord/board/tasks.json")));

  fs.rmSync(root, { recursive: true, force: true });
});

test("init preserves an existing project.config.js (no clobber)", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "coord"), { recursive: true });
  const cfgPath = path.join(root, "coord/project.config.js");
  fs.writeFileSync(cfgPath, "module.exports = { PRESENT: 1 };\n");

  const cap = capture();
  const init = createCoordInit({ log: cap.log, cwd: () => root });
  const result = init.run(["--dir", root]);

  assert.strictEqual(result.code, 0);
  assert.strictEqual(fs.readFileSync(cfgPath, "utf8"), "module.exports = { PRESENT: 1 };\n");
  assert.match(cap.text(), /skip {4}coord\/project\.config\.js {2}\(already configured\)/);
  // But the absent board + stubs are still created.
  assert.ok(fs.existsSync(path.join(root, "coord/board/tasks.json")));

  fs.rmSync(root, { recursive: true, force: true });
});

test("init defaults to cwd when --dir is omitted", () => {
  const root = tmpRoot();
  const init = createCoordInit({ log: () => {}, cwd: () => root });
  const result = init.run([]);
  assert.strictEqual(result.targetRoot, path.resolve(root));
  assert.ok(fs.existsSync(path.join(root, "coord/project.config.js")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("init --help prints usage without writing", () => {
  const root = tmpRoot();
  const cap = capture();
  const init = createCoordInit({ log: cap.log, cwd: () => root });
  const result = init.run(["--help", "--dir", root]);
  assert.strictEqual(result.code, 0);
  assert.match(cap.text(), /Usage: coord init/);
  assert.ok(!fs.existsSync(path.join(root, "coord/project.config.js")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("init rejects unexpected args with exit 1", () => {
  const cap = capture();
  const init = createCoordInit({ log: cap.log, cwd: () => os.tmpdir() });
  const result = init.run(["--bogus"]);
  assert.strictEqual(result.code, 1);
  assert.match(cap.text(), /unexpected argument/);
});

// ---------------------------------------------------------------------------
// starter board shape (single source of truth for init + release cut)
// ---------------------------------------------------------------------------

test("starter board has SETUP-001/SAMPLE-001 and parameterized version", () => {
  const board = buildStarterBoard(7);
  assert.strictEqual(board.version, 7);
  const rows = board.sections.find((s) => s.kind === "table").rows;
  assert.deepStrictEqual(rows.map((r) => r.ID), ["SETUP-001", "SAMPLE-001"]);
  assert.strictEqual(buildStarterBoard().version, 1);
});
