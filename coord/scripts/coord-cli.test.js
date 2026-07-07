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
  assert.ok(registry.onboard);
  assert.ok(registry["track-presets"]);
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

// ---------------------------------------------------------------------------
// COORD-278: requirements-* subcommand dispatch coverage.
//
// Before COORD-278 the dispatcher dropped `deps` for every requirements-*
// entry (`module.run(args)`), so these subcommands always bound the real
// process.cwd()/fs and were untestable through `dispatch()`. They now thread
// `deps`, so a test can inject log/cwd/fs and assert routing + behavior
// without touching the real repo.
// ---------------------------------------------------------------------------

// The requirements-* subcommands whose registry entries previously ignored
// injected deps. Each must route through dispatch() with the injected log.
const REQUIREMENTS_SUBCOMMANDS = [
  "requirements-import",
  "requirements-linkage",
  "requirements-traceability",
  "requirements-screen-coverage",
  "requirements-persona-workflow",
  "requirements-evidence-policy",
  "requirements-donor-reuse",
  "requirements-artifacts",
  "requirements-walking-skeleton",
];

function reqFixtureBoard(rows) {
  return {
    version: 1,
    metadata: { title: "Fixture", last_updated: "2026-06-26T00:00:00Z", canonical_references: [] },
    sections: [{ kind: "table", level: 3, heading: "Rows", separator_before: false, columns: [], rows }],
  };
}

for (const name of REQUIREMENTS_SUBCOMMANDS) {
  // Dispatch test with injected deps and NO real cwd/fs binding: the `--help`
  // path returns before any filesystem access. If deps were not threaded the
  // module would log to the real console and `cap` would stay empty.
  test(`dispatch threads deps to ${name} --help (no real fs)`, () => {
    const cap = capture();
    const fsTrap = {
      existsSync: () => { throw new Error("real fs touched"); },
      readFileSync: () => { throw new Error("real fs touched"); },
      readdirSync: () => { throw new Error("real fs touched"); },
    };
    const result = dispatch([name, "--help"], {
      log: cap.log,
      fs: fsTrap,
      cwd: "/nonexistent-coord278",
    });
    assert.strictEqual(result.code, 0, `${name} --help should exit 0`);
    assert.match(cap.text(), /Usage:/, `${name} --help should log usage via injected deps.log`);
  });
}

test("requirements-linkage honors an injected fake fs/cwd through dispatch", () => {
  const cap = capture();
  const reads = [];
  const board = reqFixtureBoard([
    { ID: "A-001", Repo: "X", Type: "feature", Status: "todo", Description: "[REQ-001] Linked" },
  ]);
  const fakeFs = {
    existsSync: (p) => String(p).endsWith("tasks.json"),
    readFileSync: (p) => {
      reads.push(String(p));
      return JSON.stringify(board);
    },
  };
  const result = dispatch(["requirements-linkage"], {
    log: cap.log,
    fs: fakeFs,
    cwd: "/virtual-root",
  });
  assert.strictEqual(result.code, 0);
  assert.ok(reads.some((p) => p.endsWith("tasks.json")), "should read the board through injected fs");
  assert.match(cap.text(), /Requirements Linkage/);
});

for (const cmd of ["requirements-linkage", "requirements-traceability"]) {
  test(`${cmd} fails with a friendly error on malformed board JSON (no stack trace)`, () => {
    const cap = capture();
    const fakeFs = {
      existsSync: () => true,
      readFileSync: () => "{ this is not valid json",
    };
    const result = dispatch([cmd], { log: cap.log, fs: fakeFs, cwd: "/virtual-root" });
    assert.strictEqual(result.code, 1);
    assert.match(cap.text(), new RegExp(`${cmd}: malformed JSON in board`));
  });
}

test("requirements-evidence-policy fails with a friendly error on malformed board JSON", () => {
  const cap = capture();
  const fakeFs = {
    existsSync: () => true,
    readFileSync: () => "{ broken",
  };
  // --registry is required; existsSync returns true for it so we reach the parse.
  const result = dispatch(["requirements-evidence-policy", "--registry", "reg.json"], {
    log: cap.log,
    fs: fakeFs,
    cwd: "/virtual-root",
  });
  assert.strictEqual(result.code, 1);
  assert.match(cap.text(), /requirements-evidence-policy: malformed JSON in board/);
});

// COORD-298: extend the malformed-JSON friendly-error hardening (COORD-278
// shape) to the remaining 5 requirements-* modules that still had bare
// JSON.parse on board/registry/source reads. Each, given malformed JSON via an
// injected fs, must log "<cmd>: malformed JSON in <file> ..." and exit 1 with
// no stack trace. Fully sandboxed: injected fs/cwd, no live coord/ writes.
const MALFORMED_JSON_CASES = [
  { cmd: "requirements-screen-coverage", args: [], expect: /requirements-screen-coverage: malformed JSON in screen index/ },
  { cmd: "requirements-persona-workflow", args: [], expect: /requirements-persona-workflow: malformed JSON in matrix/ },
  { cmd: "requirements-donor-reuse", args: [], expect: /requirements-donor-reuse: malformed JSON in matrix/ },
  { cmd: "requirements-artifacts", args: ["--validate", "artifact.json"], expect: /requirements-artifacts: malformed JSON in artifact/ },
  { cmd: "requirements-walking-skeleton", args: [], expect: /requirements-walking-skeleton: malformed JSON in board/ },
];

for (const { cmd, args, expect } of MALFORMED_JSON_CASES) {
  test(`${cmd} fails with a friendly error on malformed JSON (no stack trace)`, () => {
    const cap = capture();
    const fakeFs = {
      existsSync: () => true,
      readFileSync: () => "{ this is not valid json",
    };
    const result = dispatch([cmd, ...args], { log: cap.log, fs: fakeFs, cwd: "/virtual-root" });
    assert.strictEqual(result.code, 1, `${cmd} should exit 1 on malformed JSON`);
    assert.match(cap.text(), expect);
    assert.doesNotMatch(cap.text(), /at Object\.|at JSON\.parse|node:internal/, `${cmd} should not leak a stack trace`);
  });
}

test("requirements-import reads each source exactly once through injected fs", () => {
  const cap = capture();
  const reads = [];
  const markdown = ["# Reqs", "", "## REQ-001: One", "Statement."].join("\n");
  const fakeFs = {
    existsSync: (p) => String(p).endsWith("src.md"),
    readFileSync: (p) => {
      reads.push(String(p));
      return markdown;
    },
  };
  const result = dispatch(["requirements-import", "--source", "src.md", "--json"], {
    log: cap.log,
    fs: fakeFs,
    cwd: "/virtual-root",
  });
  assert.strictEqual(result.code, 0);
  // Single read: pre-fix sourceRecord did a second read via the module fs (which
  // here, with no real file on disk, would have thrown ENOENT).
  assert.strictEqual(reads.filter((p) => p.endsWith("src.md")).length, 1);
});

test("requirements-import fails closed on a duplicate requirement id", () => {
  const cap = capture();
  const mdA = ["# A", "", "## REQ-001: From A", "Statement A."].join("\n");
  const mdB = ["# B", "", "## REQ-001: From B", "Statement B."].join("\n");
  const fakeFs = {
    existsSync: () => true,
    readFileSync: (p) => (String(p).endsWith("a.md") ? mdA : mdB),
  };
  const result = dispatch(
    ["requirements-import", "--source", "a.md", "--source", "b.md"],
    { log: cap.log, fs: fakeFs, cwd: "/virtual-root" }
  );
  assert.strictEqual(result.code, 1);
  assert.match(cap.text(), /duplicate requirement id REQ-001/);
});
